/**
 * 登录会话建立
 *
 * 账号密码登录与 QQ 登录共用同一套会话初始化逻辑：互踢版本号、离线 HP/MP 恢复、
 * 过期战斗清理、JWT 签发。抽成一处是为了避免两种登录方式各写一份后行为逐渐分叉。
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;

function getAuthConfig() {
    return configLoader.getConfig('game_balance')?.auth || {};
}

/**
 * 提取客户端 IP
 *
 * 只用 req.ip：它已经按 Express 的 trust proxy 设置解析过 X-Forwarded-For
 * （生产部署配 TRUST_PROXY_HOPS=1 时取的是代理写入的客户端地址）。
 * 不要自己读 x-forwarded-for 第一段 —— 那一跳是客户端可随便伪造的，
 * 伪造后限流与日志会全部记到同一个假 IP 上。
 */
function getClientIp(req) {
    return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || null;
}

/**
 * 离线 HP/MP 恢复
 *
 * DualTimeService.processOfflineTime 原定义后从未被调用，导致玩家 MP 耗尽后永远为 0。
 * 现在按 last_online 计算离线时长补发恢复量；死亡/闭关中/战斗中各有独立结算逻辑，此处跳过。
 * 恢复上限单次 24 小时（processOfflineTime 内部限制），避免长期未登录玩家恢复过量。
 */
async function applyOfflineRecovery(player) {
    try {
        if (!player.last_online || player.is_dead || player.is_secluded) return;

        const offlineDurationSec = Math.max(0, Math.floor((Date.now() - new Date(player.last_online).getTime()) / 1000));
        // 离线 60 秒以内视为连续在线，不做无意义计算
        if (offlineDurationSec < 60) return;

        const DualTimeService = require('./DualTimeService');
        // processOfflineTime 现在自己在行锁内落库，不再依赖调用方的 player.save()
        const recovery = await DualTimeService.processOfflineTime(player, offlineDurationSec);
        if (recovery.hp_recovered > 0 || recovery.mp_recovered > 0) {
            console.log(`[Login] 玩家 ${player.username} 离线 ${Math.floor(offlineDurationSec / 60)} 分钟，恢复 HP +${recovery.hp_recovered} / MP +${recovery.mp_recovered}`);
        }
    } catch (err) {
        console.warn('[Login] 离线 HP/MP 恢复失败:', err.message);
    }
}

/**
 * 清理上次会话遗留的过期战斗记录，解决"一进游戏就显示战斗"
 * 场景：玩家上次战斗未正常结束（关浏览器/服务重启），expires_at 已过的战斗在此清除
 */
async function cleanExpiredBattles(player) {
    try {
        const CombatService = require('../services/CombatService');
        const cleaned = await CombatService.cleanExpiredBattles(player.id);
        if (cleaned > 0) {
            console.log(`[Login] 玩家 ${player.username} 登录时清理了 ${cleaned} 条过期战斗记录`);
        }
    } catch (err) {
        console.warn('[Login] 清理过期战斗记录失败:', err.message);
    }
}

/**
 * 完成一次登录：更新会话字段并签发 JWT
 *
 * 调用方需自行完成身份校验（密码比对或第三方身份核对），本函数假定 player 已确认可登录。
 * token_version 自增会让该玩家此前签发的所有 JWT 立即失效，即单点登录互踢。
 *
 * @param {Object} player - 已校验通过的 Player 实例
 * @param {Object} req - Express 请求，用于取客户端 IP
 * @returns {Promise<string>} 签发的 JWT
 */
async function issueLoginToken(player, req) {
    player.token_version = (player.token_version || 0) + 1;
    player.ip_address = getClientIp(req);

    await applyOfflineRecovery(player);

    // 实例上此刻只有 token_version / ip_address / last_online 是脏字段
    // （恢复结果已经由 PlayerStateStore 写库），所以这次 save 不会再整块回写 attributes
    player.last_online = new Date();
    await player.save();

    await cleanExpiredBattles(player);

    // rk：请求签名密钥。随 JWT 下发，只有持有本令牌的客户端能对写操作签名；
    // 服务端验签时从已 verify 的 JWT 载荷取回 rk（见 middleware/requestGuard.js）。
    // 每次登录（token_version 自增）都换新 rk，旧会话即便抓到包也无法继续签新请求。
    const rk = crypto.randomBytes(32).toString('base64url');

    return jwt.sign(
        { id: player.id, username: player.username, v: player.token_version, rk },
        process.env.JWT_SECRET,
        { expiresIn: getAuthConfig().jwt_expires_in ?? '7d' }
    );
}

/**
 * 登录成功响应里的玩家摘要，前端据此渲染首屏
 */
function toLoginPlayerPayload(player) {
    return {
        id: player.id,
        nickname: player.nickname,
        realm: player.realm,
        role: player.role
    };
}

module.exports = { issueLoginToken, toLoginPlayerPayload, getClientIp };
