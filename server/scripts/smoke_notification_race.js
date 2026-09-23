/**
 * 公告 metadata 的丢更新探针（需要 MySQL，走 .env 指向的隔离库 re_xiuxian_test）
 *
 * `system_notifications.metadata` 是一个 TEXT 里装 JSON 的**整块列**，SQL 没法只改其中一个键。
 * 它有两个互不知晓的写入方：GM 编辑公告（写 imageUrls / 清 notice_pushed）与
 * 调度器打推送标记（写 notice_pushed / pushed_at）。改造前两条都是
 * "无锁读 → 内存里合并 → update 整块"，交错起来就是标准的旧快照覆盖新快照，
 * 两种后果玩家都看得见：配图凭空少一张，或者同一张公告下一轮又全服弹一次。
 *
 * 现在两处都走 CAS（写回时 where 带上"我读到的那份原值"，撞车就重读再合）。
 * 这条探针在真库上量三件事：
 *   N1 强制撞车：调度器拿一份**过期**的 metadata 去写，库里的新配图必须还在；
 *   N2 两路真并发（编辑 ∥ 推送）跑若干轮，任何一轮都不许出现"只剩一方的键"；
 *   N3 同时来两次推送标记，只准有一次真写入（不重复盖 pushed_at）。
 * 控制跑在同一条命令里做（把 CAS 换回旧的整块写 → N1/N2 必须红）。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_notification_race.js
 */
'use strict';

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

async function metaOf(id) {
    const SystemNotification = require('../models/system_notification');
    const row = await SystemNotification.findByPk(id);
    try {
        return JSON.parse(row?.metadata || '{}') || {};
    } catch {
        return { __broken: row?.metadata };
    }
}

(async () => {
    const { initializeModules } = require('../modules');
    await initializeModules();
    await require('../game').initializeGameServices(require('../modules').infrastructure.ConfigLoader);

    const sequelize = require('../config/database');
    const SystemNotification = require('../models/system_notification');
    const NotificationService = require('../game/services/NotificationService');

    async function makeAnnouncement(metadata) {
        return SystemNotification.create({
            type: 'announcement', title: '并发探针公告', content: '只在隔离库里活着',
            priority: 'normal', metadata: JSON.stringify(metadata), isActive: true
        });
    }

    // —— N1：调度器手上那份已经过期（GM 刚写过配图）——
    const a = await makeAnnouncement({ imageUrls: [] });
    const stale = a.metadata;                                  // {} 那一份
    await a.update({ metadata: JSON.stringify({ imageUrls: ['/api/uploads/announcements/fresh.png'] }) });
    const pushed = await NotificationService.markAsPushed({ id: a.id, metadata: stale });
    const afterStale = await metaOf(a.id);
    check('N1 拿过期那份写标记时，库里刚写好的配图必须还在（CAS 撞车要重读再合）',
        pushed === true && afterStale.notice_pushed === true
        && Array.isArray(afterStale.imageUrls) && afterStale.imageUrls.includes('/api/uploads/announcements/fresh.png'),
        `markAsPushed=${pushed} 库里=${JSON.stringify(afterStale)}`);

    // —— N2：两路真并发，跑够轮数去撞那个窗口 ——
    // 顺便数 metadata 写回了多少次：一次撞车会多出一条 update，
    // 所以"总写回次数 > 参写腿数"就是"这一轮真撞上了"的观测证据（否则 N2 只是没测到东西）。
    const realUpdate = SystemNotification.update.bind(SystemNotification);
    let updateCalls = 0;
    SystemNotification.update = (...args) => { updateCalls += 1; return realUpdate(...args); };
    let lost = [];
    for (let round = 1; round <= 12; round++) {
        const row = await makeAnnouncement({ imageUrls: [] });
        const url = `/api/uploads/announcements/r${round}.png`;
        const [editRes, pushRes] = await Promise.all([
            NotificationService.updateNotificationFields(row.id, {
                title: '并发探针公告', content: '只在隔离库里活着', priority: 'normal', imageUrls: [url]
            }).then(r => r).catch(e => ({ error: e.message })),
            NotificationService.markAsPushed(row).then(r => r).catch(e => ({ error: e.message }))
        ]);
        const after = await metaOf(row.id);
        const both = after.notice_pushed === true
            && Array.isArray(after.imageUrls) && after.imageUrls.includes(url);
        if (!both) {
            lost.push(`第${round}轮 编辑${editRes && !editRes.error ? '成' : `败(${editRes && editRes.error})`}/推送${pushRes === true ? '成' : `回${JSON.stringify(pushRes)}`} → ${JSON.stringify(after)}`);
        }
    }
    check('N2 编辑与推送并发 12 轮：每一轮两个键都要在（谁都不许把对方抹掉）',
        lost.length === 0,
        `出问题的轮=${lost.join(' ｜ ') || '无'}；这一批 metadata 写回了 ${updateCalls} 次（两路各 12 次=24 起步，多出来的是真撞上的重试；窗口有没有撞上不作为判定，确定性的撞车证明在 N1/N3）`);
    SystemNotification.update = realUpdate;

    // —— N3：同一瞬间两次推送标记 ——
    const b = await makeAnnouncement({ imageUrls: ['/x.png'] });
    const bothLegs = await Promise.all([
        NotificationService.markAsPushed({ id: b.id, metadata: b.metadata }),
        NotificationService.markAsPushed({ id: b.id, metadata: b.metadata })
    ]);
    check('N3 两条腿同时标"已推送"：只准一次真写进去（后那条必须 CAS 撞车→重读→发现已标记→不改）',
        bothLegs.filter(x => x === true).length === 1 && (await metaOf(b.id)).notice_pushed === true,
        `两条腿=${JSON.stringify(bothLegs)} 库里=${JSON.stringify(await metaOf(b.id))}`);

    // 清理：只删自己建的那几行（按标题 + 记下的小 ID 双保险，N2 那 12 行也只有这个标题）
    await SystemNotification.destroy({ where: { title: '并发探针公告' } });
    await SystemNotification.destroy({ where: { id: [a.id, b.id] } });
    const residue = await SystemNotification.count({ where: { title: '并发探针公告' } });
    check('清理：探针公告一条不留', residue === 0, `残留=${residue}`);

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项断言通过，失败 ${failed.length} 项`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    try {
        const SystemNotification = require('../models/system_notification');
        await SystemNotification.destroy({ where: { title: '并发探针公告' } });
    } catch {}
    process.exit(1);
});
