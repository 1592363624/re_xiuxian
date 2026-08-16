/**
 * 大世界移动服务（World Map MVP）
 *
 * 设计定位：
 *   在保留原有"跨图延时移动"（start-move）体系的同时，
 *   为玩家提供连续世界坐标 (pos_x, pos_y)，支撑 2D 俯视大世界地图的即时移动。
 *
 * 权威校验（防作弊）：
 *   - 单次移动最大步长限制（MAX_STEP），禁止瞬移
 *   - 移动最小间隔限制（MOVE_INTERVAL_MS），禁止高频刷移动
 *   - 目标点越界钳制（世界边界）
 *   - 跨图判定：目标点归属最近地图，境界不足禁止踏入
 *   - 状态机互斥校验：闭关/战斗/历练/移动等 exclusive 状态期间禁止走动
 *
 * 多人同步：
 *   - Socket.IO 房间：world:map:{mapId}
 *   - 玩家连接/跨图时加入对应房间，移动结果广播给同图玩家
 */
const Player = require('../../models/player');
const PlayerMapPosition = require('../../models/playerMapPosition');
const PlayerMovement = require('../../models/playerMovement');
const PlayerSect = require('../../models/playerSect');
const MapConfigLoader = require('./MapConfigLoader');
const PlayerStateMachine = require('../state/PlayerStateMachine');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const sequelize = require('../../config/database');

const SPAWN_RADIUS = 8;
const MAX_STEP = 80;
const MOVE_INTERVAL_MS = 300;
const WORLD_EVENT = 'world:player-moved';

class WorldMovementService {
    constructor() {
        this.mapConfig = MapConfigLoader;
    }

    /**
     * 获取世界边界（由所有地图节点坐标外扩得到，防止越界）
     * @returns {{minX:number, maxX:number, minY:number, maxY:number}}
     */
    getWorldBounds() {
        const maps = this.mapConfig.getAllMaps();
        let maxAbs = 10;
        for (const m of maps) {
            maxAbs = Math.max(maxAbs, Math.abs(m.x || 0), Math.abs(m.y || 0));
        }
        const margin = 40;
        return {
            minX: -(maxAbs + margin),
            maxX: maxAbs + margin,
            minY: -(maxAbs + margin),
            maxY: maxAbs + margin
        };
    }

    /**
     * 获取玩家的世界位置记录，不存在则创建（不分配坐标）
     * @param {number} playerId
     * @returns {Promise<Object>} PlayerMapPosition 实例
     */
    async getOrCreatePosition(playerId) {
        let pos = await PlayerMapPosition.findOne({ where: { player_id: playerId } });
        if (!pos) {
            const player = await Player.findByPk(playerId);
            const defaultMap = this.mapConfig.getDefaultMap();
            const mapId = player.current_map_id || defaultMap.id;
            pos = await PlayerMapPosition.create({ player_id: playerId, map_id: mapId });
        }
        return pos;
    }

    /**
     * 确保玩家拥有出生坐标（登录时/首次打开大世界时调用）
     * 出生点：默认地图（越国）中心附近随机偏移
     * @param {number} playerId
     * @returns {Promise<{map_id:number, pos_x:number, pos_y:number}>}
     */
    async ensureSpawn(playerId) {
        const pos = await this.getOrCreatePosition(playerId);
        if (pos.pos_x != null && pos.pos_y != null) {
            return { map_id: pos.map_id, pos_x: Number(pos.pos_x), pos_y: Number(pos.pos_y) };
        }

        const defaultMap = this.mapConfig.getDefaultMap();
        const centerX = defaultMap.x || 0;
        const centerY = defaultMap.y || 0;
        let offsetX = 0;
        let offsetY = 0;
        // 随机偏移（排除原点正中心，避免所有玩家完全重叠）
        while (Math.abs(offsetX) < 2 && Math.abs(offsetY) < 2) {
            offsetX = (Math.random() * 2 - 1) * SPAWN_RADIUS;
            offsetY = (Math.random() * 2 - 1) * SPAWN_RADIUS;
        }
        pos.pos_x = Math.round((centerX + offsetX) * 100) / 100;
        pos.pos_y = Math.round((centerY + offsetY) * 100) / 100;
        pos.map_id = defaultMap.id;
        pos.last_visit_time = new Date();
        await pos.save();

        const player = await Player.findByPk(playerId);
        if (player && player.current_map_id !== defaultMap.id) {
            player.current_map_id = defaultMap.id;
            await player.save();
        }
        return { map_id: pos.map_id, pos_x: Number(pos.pos_x), pos_y: Number(pos.pos_y) };
    }

    /**
     * 获取玩家大世界状态（含地图信息）
     * @param {number} playerId
     * @returns {Promise<Object>}
     */
    async getWorldState(playerId) {
        const spawn = await this.ensureSpawn(playerId);
        const map = this.mapConfig.getMap(spawn.map_id);
        return {
            map_id: spawn.map_id,
            map_name: map ? map.name : '未知',
            map_type: map ? map.type : null,
            pos_x: spawn.pos_x,
            pos_y: spawn.pos_y,
            bounds: this.getWorldBounds(),
            server_time: Date.now()
        };
    }

    /**
     * 世界移动（服务器权威校验后更新坐标）
     * @param {number} playerId
     * @param {number} targetX
     * @param {number} targetY
     * @returns {Promise<{success:boolean, message:string, data?:Object}>}
     */
    async move(playerId, targetX, targetY) {
        const x = Number(targetX);
        const y = Number(targetY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return { success: false, message: '目标坐标无效' };
        }

        const player = await Player.findByPk(playerId);
        if (!player) return { success: false, message: '玩家不存在' };

        // 状态机互斥校验：闭关/战斗/历练/移动/封禁等 exclusive 状态期间禁止走动
        const stateCheck = await PlayerStateMachine.canStart(
            playerId,
            PlayerStateMachine.PlayerState.MOVING,
            { source: 'route', stateType: 'world_move' }
        );
        if (!stateCheck.allowed) {
            return { success: false, message: stateCheck.reason };
        }

        const pos = await this.getOrCreatePosition(playerId);
        const curX = pos.pos_x != null ? Number(pos.pos_x) : null;
        const curY = pos.pos_y != null ? Number(pos.pos_y) : null;

        // 无坐标时先分配出生点
        let fromMapId;
        if (curX == null || curY == null) {
            const spawn = await this.ensureSpawn(playerId);
            fromMapId = spawn.map_id;
            pos.pos_x = spawn.pos_x;
            pos.pos_y = spawn.pos_y;
        } else {
            fromMapId = pos.map_id;
        }

        // 移动最小间隔校验（防高频刷移动）
        if (pos.latest_move_time) {
            const elapsed = Date.now() - new Date(pos.latest_move_time).getTime();
            if (elapsed < MOVE_INTERVAL_MS) {
                return {
                    success: false,
                    message: '移动过于频繁，请稍候',
                    data: { cooldown_ms: MOVE_INTERVAL_MS - elapsed }
                };
            }
        }

        // 步长校验（防瞬移作弊）
        const distance = Math.sqrt((x - pos.pos_x) ** 2 + (y - pos.pos_y) ** 2);
        if (distance > MAX_STEP) {
            return { success: false, message: `单次移动距离不能超过 ${MAX_STEP} 格` };
        }

        // 目标点钳制到世界边界内
        const bounds = this.getWorldBounds();
        const clampedX = Math.max(bounds.minX, Math.min(bounds.maxX, x));
        const clampedY = Math.max(bounds.minY, Math.min(bounds.maxY, y));

        // 目标地图判定：离目标点最近的地图
        const targetMap = this.nearestMap(clampedX, clampedY);
        if (!targetMap) return { success: false, message: '无法定位目标区域' };

        // 跨图时校验境界要求
        if (targetMap.id !== fromMapId) {
            const RealmService = require('../core/RealmService');
            const check = RealmService.meetsRealmRequirement(player, targetMap.requiredRealm || '凡人');
            // 兼容：要求 rank<=0（如"凡人"）表示无实际门槛，凡人都能进；
            // RealmService 的 playerRank<=0 守卫会把 rank 0 玩家误判为不满足，这里显式放行
            const allowed = check.met || check.requiredRank <= 0;
            if (!allowed) {
                return { success: false, message: `境界不足，无法进入【${targetMap.name}】区域` };
            }
        }

        const now = new Date();
        const t = await sequelize.transaction();
        try {
            pos.pos_x = Math.round(clampedX * 100) / 100;
            pos.pos_y = Math.round(clampedY * 100) / 100;
            pos.map_id = targetMap.id;
            pos.last_visit_time = now;
            pos.latest_move_time = now;
            await pos.save({ transaction: t });

            const mapChanged = fromMapId !== targetMap.id;
            if (mapChanged) {
                player.current_map_id = targetMap.id;
                player.last_map_move_time = now;
                await player.save({ transaction: t });
            }

            const fromMap = this.mapConfig.getMap(fromMapId) || { name: '未知' };
            await PlayerMovement.create({
                player_id: playerId,
                from_map_id: fromMapId,
                from_map_name: fromMap.name,
                to_map_id: targetMap.id,
                to_map_name: targetMap.name,
                distance: Math.round(distance * 100) / 100,
                mp_consumed: 0,
                duration_seconds: 0,
                status: 'completed',
                started_at: now,
                completed_at: now
            }, { transaction: t });

            await t.commit();
        } catch (e) {
            await t.rollback();
            throw e;
        }

        // 同步 Socket 房间（跨图时换房间）
        await this.syncSocketRoom(playerId, targetMap.id);

        // 广播给同图玩家（旧图+新图）
        let sectName = null;
        try {
            const mySect = await PlayerSect.findOne({ where: { player_id: playerId } });
            if (mySect) sectName = this.getSectName(mySect.sect_id);
        } catch (e) {
            // 宗门查询失败不阻塞移动广播
        }
        this.broadcastMove(playerId, fromMapId, targetMap.id, {
            player_id: playerId,
            name: player.nickname || player.username || `玩家${playerId}`,
            realm: player.realm,
            sect_name: sectName,
            map_id: targetMap.id,
            map_name: targetMap.name,
            pos_x: Number(pos.pos_x),
            pos_y: Number(pos.pos_y)
        });

        return {
            success: true,
            message: `移动至【${targetMap.name}】区域`,
            data: {
                map_id: targetMap.id,
                map_name: targetMap.name,
                map_type: targetMap.type,
                pos_x: Number(pos.pos_x),
                pos_y: Number(pos.pos_y),
                distance: Math.round(distance * 100) / 100,
                map_changed: fromMapId !== targetMap.id,
                cooldown_ms: MOVE_INTERVAL_MS
            }
        };
    }

    /**
     * 计算距离目标点最近的地图节点
     * @param {number} x
     * @param {number} y
     * @returns {Object|null}
     */
    nearestMap(x, y) {
        const maps = this.mapConfig.getAllMaps();
        let nearest = null;
        let nearestDist = Infinity;
        for (const m of maps) {
            const dx = (m.x || 0) - x;
            const dy = (m.y || 0) - y;
            const d = dx * dx + dy * dy;
            if (d < nearestDist) {
                nearest = m;
                nearestDist = d;
            }
        }
        return nearest;
    }

    /**
     * 获取指定地图的在线玩家（大世界同图可见）
     * @param {number} mapId
     * @returns {Promise<Array>}
     */
    async getOnlinePlayersInMap(mapId) {
        const ws = WebSocketNotificationService;
        const onlineIds = Array.from(ws.onlineUsers.keys()).map(id => Number(id));
        if (onlineIds.length === 0) return [];

        const positions = await PlayerMapPosition.findAll({
            where: { player_id: onlineIds, map_id: mapId }
        });
        if (positions.length === 0) return [];

        const idToPos = new Map(positions.map(p => [Number(p.player_id), p]));
        const players = await Player.findAll({
            where: { id: Array.from(idToPos.keys()) },
            attributes: ['id', 'nickname', 'username', 'realm']
        });

        // 宗门信息：玩家宗门关系在 player_sects 表，名称在 sect_data.json 配置
        const sectMap = new Map();
        try {
            const sects = await PlayerSect.findAll({
                where: { player_id: Array.from(idToPos.keys()) }
            });
            for (const s of sects) {
                sectMap.set(Number(s.player_id), this.getSectName(s.sect_id));
            }
        } catch (e) {
            console.warn('[WorldMovement] 查询在线玩家宗门失败:', e.message);
        }

        return players.map(p => {
            const pos = idToPos.get(Number(p.id));
            return {
                player_id: Number(p.id),
                name: p.nickname || p.username || `玩家${p.id}`,
                realm: p.realm,
                sect_name: sectMap.get(Number(p.id)) || null,
                map_id: mapId,
                pos_x: pos.pos_x != null ? Number(pos.pos_x) : null,
                pos_y: pos.pos_y != null ? Number(pos.pos_y) : null
            };
        }).filter(p => p.pos_x != null && p.pos_y != null);
    }

    /**
     * 根据宗门ID获取宗门名称（sect_data.json）
     * @param {string} sectId - 宗门ID（如 luoyun）
     * @returns {string|null}
     */
    getSectName(sectId) {
        if (!sectId) return null;
        try {
            const config = require('../../config/sect_data.json');
            const sect = (config.sects || []).find(s => s.id === sectId);
            return sect ? sect.name : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * 获取 Socket.IO 世界房间名
     * @param {number} mapId
     * @returns {string}
     */
    getPlayerRoom(mapId) {
        return `world:map:${mapId}`;
    }

    /**
     * 同步玩家的世界房间（加入当前地图房间，离开其他地图房间）
     * @param {number} playerId
     * @param {number} mapId
     */
    async syncSocketRoom(playerId, mapId) {
        const ws = WebSocketNotificationService;
        if (!ws.io) return;
        const userInfo = ws.onlineUsers.get(playerId.toString());
        if (!userInfo) return;
        const socket = ws.io.sockets?.sockets?.get(userInfo.socketId);
        if (!socket) return;

        for (const m of this.mapConfig.getAllMaps()) {
            socket.leave(this.getPlayerRoom(m.id));
        }
        socket.join(this.getPlayerRoom(mapId));
    }

    /**
     * 广播玩家移动给旧图+新图房间内的在线玩家
     * @param {number} playerId
     * @param {number} fromMapId
     * @param {number} toMapId
     * @param {Object} payload
     */
    broadcastMove(playerId, fromMapId, toMapId, payload) {
        const ws = WebSocketNotificationService;
        if (!ws.io) return;
        const event = WORLD_EVENT;
        const rooms = new Set([this.getPlayerRoom(fromMapId), this.getPlayerRoom(toMapId)]);
        for (const room of rooms) {
            ws.io.to(room).emit(event, {
                type: event,
                player: payload,
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * 玩家 Socket 连接时调用：确保出生坐标并加入世界房间
     * @param {number} playerId
     */
    async onSocketConnect(playerId) {
        try {
            const spawn = await this.ensureSpawn(playerId);
            await this.syncSocketRoom(playerId, spawn.map_id);
            return spawn;
        } catch (e) {
            console.warn(`[WorldMovement] 玩家 ${playerId} Socket 连接初始化世界位置失败:`, e.message);
            return null;
        }
    }
}

module.exports = new WorldMovementService();
