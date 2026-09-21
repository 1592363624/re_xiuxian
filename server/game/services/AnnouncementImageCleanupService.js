/**
 * 公告配图孤儿文件清理服务
 *
 * 为什么需要：删除通知时只能带上"记录里还写着"的那几张图。以下几类图片谁也不会来删 ——
 *   1. GM 上传了但没点"发送"就关掉后台；
 *   2. 通知记录被运维直接删行、或被软删除留下isolated 历史数据；
 *   3. 旧数据里 metadata 的 URL 已经对不上现有文件。
 * 图片一旦堆起来就是纯粹的磁盘泄漏：没有任何玩法知道它们存在，只能靠服务端自己回收。
 *
 * 判定规则（抽成纯函数 selectOrphanFiles，便于单测）：
 *   文件既不在"当前有效通知的 metadata.imageUrls 集合"里，又超过了保留窗口 → 判为孤儿。
 * 保留窗口的用意：上传与写进通知记录之间有几分钟到几小时的空窗，
 * 直接用"没被引用"这一条去删，会把 GM 正在编辑、还没点发送的那张图也删掉。
 *
 * 配置一律现读 ConfigLoader.peekConfig，保证后台改完立即生效，不缓存到模块变量。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const configLoader = require('../../modules/infrastructure/ConfigLoader');
const announcementImage = require('../../utils/announcementImage');

/** 配置未就绪时的兜底值（与 announcementImage.js 同一套思路） */
const FALLBACK_CLEANUP = {
    enabled: true,
    interval_ms: 3600000,
    retention_hours: 24,
    log_each: false
};

class AnnouncementImageCleanupService {
    constructor() {
        this.timer = null;
    }

    /**
     * 读取清理配置（每次现读，热更新即时生效）
     * @returns {{enabled: boolean, interval_ms: number, retention_hours: number, log_each: boolean}}
     */
    getCleanupConfig() {
        const configured = configLoader.peekConfig('announcement_upload')?.cleanup || {};
        return { ...FALLBACK_CLEANUP, ...configured };
    }

    /**
     * 从磁盘文件名里挑出"应当删除"的孤儿文件
     *
     * 抽成纯函数是为了能脱离数据库与文件系统直接验证判定规则 ——
     * 删文件的语义一旦写错（比如把被引用的图删了），线上表现是"历史公告的图全部 404"，很难回滚。
     *
     * @param {Object} params
     * @param {Array<{name: string, mtimeMs: number}>} params.files - 目录里的文件（name + 修改时间毫秒）
     * @param {Set<string>} params.referencedFileNames - 有效通知正在引用的文件名集合
     * @param {number} params.nowMs - 当前时间戳（注入便于测试）
     * @param {number} params.retentionMs - 保留窗口（毫秒）
     * @returns {string[]} 应当删除的文件名
     */
    selectOrphanFiles({ files, referencedFileNames, nowMs, retentionMs }) {
        if (!Array.isArray(files)) return [];

        return files
            .filter(file => !referencedFileNames.has(file.name))
            .filter(file => (nowMs - file.mtimeMs) > retentionMs)
            .map(file => file.name);
    }

    /**
     * 汇总通知正在引用的配图文件名（含已撤回的，见下方说明）
     *
     * 只查 metadata 列并先用 LIKE 粗筛一次：全表扫 metadata TEXT 再逐条 JSON.parse 太贵，
     * 绝大多数通知根本不带图。
     * @returns {Promise<Set<string>>}
     */
    async collectReferencedFileNames() {
        const { Op } = require('sequelize');
        const SystemNotification = require('../../models/system_notification');

        // 刻意不筛 isActive：撤回（下架）只是暂时隐藏，GM 随时可能恢复，
        // 若只认"激活中"的记录，撤回满一个保留窗口图片就被回收，恢复后公告里全是 404。
        // 只有记录被真正删除时，它的图才允许被回收。
        const rows = await SystemNotification.findAll({
            attributes: ['metadata'],
            where: {
                metadata: { [Op.like]: '%imageUrls%' }
            },
            raw: true
        });

        const names = new Set();
        for (const row of rows) {
            for (const url of announcementImage.extractImageUrls(row)) {
                names.add(path.basename(url));
            }
        }
        return names;
    }

    /**
     * 读取落盘目录下的文件清单
     * @returns {Array<{name: string, mtimeMs: number}>} 目录不存在时返回空数组
     */
    listUploadedFiles() {
        const dir = announcementImage.getStorageDir();
        if (!fs.existsSync(dir)) return [];

        return fs.readdirSync(dir)
            .filter(name => announcementImage.isManagedImageUrl(`${announcementImage.getUrlPrefix()}/${name}`))
            .map(name => ({
                name,
                mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs
            }));
    }

    /**
     * 执行一次清理
     * @returns {Promise<{scanned: number, referenced: number, removed: number, skipped: boolean}>}
     */
    async run() {
        const config = this.getCleanupConfig();
        // 开关在每次执行时重读：后台把 enabled 关掉不用等下一次启动也不用 kill 进程
        if (!config.enabled) {
            return { scanned: 0, referenced: 0, removed: 0, skipped: true };
        }

        const files = this.listUploadedFiles();
        const referencedFileNames = await this.collectReferencedFileNames();

        const orphans = this.selectOrphanFiles({
            files,
            referencedFileNames,
            nowMs: Date.now(),
            retentionMs: config.retention_hours * 3600 * 1000
        });

        const dir = announcementImage.getStorageDir();
        let removed = 0;
        for (const name of orphans) {
            try {
                fs.unlinkSync(path.join(dir, name));
                removed += 1;
                if (config.log_each) {
                    console.log(`[公告配图清理] 已删除孤儿文件 ${name}`);
                }
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    console.warn(`[公告配图清理] 删除失败 ${name}: ${error.message}`);
                }
            }
        }

        console.log(
            `[公告配图清理] 扫描 ${files.length} 个文件，被引用 ${referencedFileNames.size} 个，删除孤儿 ${removed} 个`
        );

        return {
            scanned: files.length,
            referenced: referencedFileNames.size,
            removed,
            skipped: false
        };
    }

    /**
     * 启动定时清理
     * @returns {boolean} 是否真的启动了（已启动或配置关闭时返回 false）
     */
    start() {
        if (this.timer) return false;

        const config = this.getCleanupConfig();
        if (!config.enabled) {
            console.log('[公告配图清理] 配置关闭，未启动定时清理');
            return false;
        }

        this.timer = setInterval(() => {
            this.run().catch(err => console.error('[公告配图清理] 执行失败:', err.message));
        }, config.interval_ms);

        // 首轮不等一个间隔：重启后立刻把上次没跑完的清理补上
        setImmediate(() => {
            this.run().catch(err => console.error('[公告配图清理] 首轮执行失败:', err.message));
        });

        console.log(`[公告配图清理] 定时清理已启动 (${config.interval_ms}ms，保留窗口 ${config.retention_hours}h)`);
        return true;
    }

    /**
     * 停止定时清理（便于测试与优雅停机）
     */
    stop() {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    }
}

module.exports = new AnnouncementImageCleanupService();
