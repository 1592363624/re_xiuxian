/**
 * 共享行的写入卫生（棘轮闸）。
 *
 * 这是 players 那套 blobWriteGuard 的同类问题，只是发生在别的表上：兽潮事件行、宗门战战役行、
 * 资源点、宗门资金、放养地块 —— 都是"多个连接同时写同一行"。实测到的一个真实缺陷就是这个形状：
 * 调度器 `BeastInvasionService.checkExpired()` 用**无锁** findAll 读出兽潮行，结算时
 * `invasion.save()` 整行写回，于是那段时间里所有玩家打掉的伤害被原样抹回去（妖兽血量回涨）。
 * 同类问题在 `leaveWar`（参战人数只减 1）与 `_completeCapture`（同一玩家同时占两块地，
 * 贡献分少算一次）上也存在，已改成"列上原子写"。
 *
 * 为什么是棘轮而不是解析器：判断"这一行是不是在锁里读的"要跨函数看调用方，任何静态近似都会
 * 既误报又漏报（我试过按方法切块的正则解析，误报一堆）。所以这里改成数数：
 * 每个文件里"共享模型的整块 save()"出现次数必须**恰好等于**登记值 —— 多一处（新增隐患）红，
 * 少一处（真的修掉了）也红，逼着改的人回来更新依据。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const serverRoot = path.join(__dirname, '..');

/** 去掉注释：块注释按字符抹平但保留换行（行号仍然准），行注释整行去掉 */
function codeOnly(file) {
    return fs.readFileSync(path.join(serverRoot, file), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 登记 = 变量名 → 允许整块 save() 的文件与处数，以及**为什么安全**。
 * 依据必须能在代码里查到；写不出依据的就该改成列级写或补 FOR UPDATE，而不是往这里加一行。
 */
const REVIEWED = [
    {
        file: 'game/services/BeastInvasionService.js',
        pattern: /\binvasion\.save\(/g,
        count: 2,
        reason: '两处都在 attackBeast/donate 主流程里：读该行时带 lock: t.LOCK.UPDATE（第 802、1545 行附近），'
            + '整行写回是同一笔锁内事务。调度器与聚合战报那两处已改成只写自己负责的列。'
    },
    {
        file: 'game/services/SectWarService.js',
        pattern: /\bwar\.save\(/g,
        count: 3,
        reason: 'joinWar（第 699 行）与结算路径读战役行时都带 FOR UPDATE；leaveWar 那处无锁整块写回'
            + '已改成 `GREATEST(col - 1, 0)` 的列上原子递减。'
    },
    {
        file: 'game/services/SectWarService.js',
        pattern: /\bterritory\.save\(/g,
        count: 3,
        reason: '占领与结算的资源点读取带 FOR UPDATE（_completeCapture 第 2067 行附近、结算在战役锁之内）。'
    },
    {
        file: 'game/services/SectWarService.js',
        pattern: /\bfund\.save\(/g,
        count: 3,
        reason: '资金一律经 _getOrCreateSectFund(…, t)：传了事务就带 FOR UPDATE。'
            + '唯一 t=null 的调用点只做展示读取（那条 save 只写刚 create 出来的新行的宗主字段）。'
    },
    {
        file: 'game/services/SectWarService.js',
        pattern: /\bparticipant\.save\(/g,
        count: 1,
        reason: 'leaveWar 里那一处：参战记录本身是 FOR UPDATE 读出来的（第 826 行）；'
            + '_completeCapture 的贡献分已改成 `SectWarParticipant.increment`。'
    },
    {
        file: 'game/services/GardenService.js',
        pattern: /\bplot\.save\(/g,
        count: 1,
        reason: '收获流程在锁内读地块（同函数上文有 lock: t.LOCK.UPDATE）。'
    },
    {
        // 2026-09-20 定下锁顺序契约后从"待办"转成"已登记依据"
        file: 'game/services/BeastPastureService.js',
        pattern: /\bpasture\.save\(/g,
        count: 2,
        reason: '全服务统一锁顺序 SpiritBeast → SpiritBeastPasture → PlayerGarden：偷菜与召回/自动结算写的'
            + '放养行都是带 FOR UPDATE 读出来的（灵兽行经 _lockBeastRow 先锁），整行写回在同一把锁内。'
            + '门禁：tests/BeastPastureLockOrder.test.js 钉顺序，scripts/smoke_pasture_race.js 真库并发验'
            + '（改之前 10/10 轮 "Deadlock found when trying to get lock"）。'
    }
];

describe('共享行的整块写回必须被逐条登记（棘轮）', () => {
    test.each(REVIEWED.map(r => [r.file, r.pattern, r.count, r.reason]))(
        '%s 的整块 save() 处数仍等于登记值', (file, pattern, count) => {
            const found = (codeOnly(file).match(pattern) || []).length;
            expect({ file, found, registered: count }).toEqual({ file, found: count, registered: count });
        }
    );

    test('登记条目本身不许过期（依据写的是"第几行"，代码动了就要重新核对）', () => {
        for (const entry of REVIEWED) {
            expect(fs.existsSync(path.join(serverRoot, entry.file))).toBe(true);
            expect(entry.reason.length).toBeGreaterThan(20);
        }
    });
});
