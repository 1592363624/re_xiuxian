/**
 * GM 后台装备管理 API
 * 封装装备管理路由（/api/admin/equipment/*）调用
 *
 * 业务说明：
 *   - 所有接口需 JWT 鉴权 + admin 权限
 *   - 所有操作记录到 admin_logs 表，便于审计追溯
 *   - 字段范围校验由后端统一处理，前端仅做基础校验
 */
import apiClient from './index';

/**
 * 装备记录（含法宝深度系统字段）
 */
export interface AdminEquipmentRecord {
    id: number;
    player_id: number;
    slot: string;
    item_key: string;
    equipped_at: string;
    createdAt: string;
    durability: number;
    max_durability: number;
    refine_level: number;
    is_benming: boolean;
    benming_slot: number | null;
    spirit_power: number;
    sort_order: number;
    is_summoned: boolean;
}

/**
 * 装备列表查询参数
 */
export interface EquipmentListQuery {
    keyword?: string;
    slot?: string;
    is_benming?: boolean;
    page?: number;
    pageSize?: number;
}

/**
 * 装备列表响应
 */
export interface EquipmentListData {
    list: AdminEquipmentRecord[];
    total: number;
    page: number;
    pageSize: number;
}

/**
 * 指定玩家装备详情响应
 */
export interface PlayerEquipmentData {
    player: {
        id: number;
        nickname: string;
        realm: string;
        realm_rank: number | null;
        spirit_stones: number;
    };
    equipments: AdminEquipmentRecord[];
    count: number;
}

/**
 * 修改装备记录的请求体
 * 所有字段都是可选的，仅传入需要修改的字段
 */
export interface UpdateEquipmentPayload {
    durability?: number;
    max_durability?: number;
    refine_level?: number;
    sort_order?: number;
    is_benming?: boolean;
    is_summoned?: boolean;
    spirit_power?: number;
}

/**
 * 查询装备列表（分页）
 * GET /admin/equipment/list
 */
export const getEquipmentList = (params: EquipmentListQuery = {}) => {
    return apiClient.get('/admin/equipment/list', { params });
};

/**
 * 查询指定玩家所有装备
 * GET /admin/equipment/:playerId
 */
export const getPlayerEquipment = (playerId: number) => {
    return apiClient.get(`/admin/equipment/${playerId}`);
};

/**
 * 修改装备记录
 * PUT /admin/equipment/:playerId/record/:id
 */
export const updateEquipmentRecord = (playerId: number, recordId: number, payload: UpdateEquipmentPayload) => {
    return apiClient.put(`/admin/equipment/${playerId}/record/${recordId}`, payload);
};

/**
 * 重置装备记录（恢复初始耐久/祭炼等级清零/取消本命）
 * POST /admin/equipment/:playerId/record/:id/reset
 */
export const resetEquipmentRecord = (playerId: number, recordId: number) => {
    return apiClient.post(`/admin/equipment/${playerId}/record/${recordId}/reset`);
};

/**
 * GM 一键修理指定玩家所有装备（无消耗）
 * POST /admin/equipment/:playerId/repair-all
 */
export const gmRepairAll = (playerId: number) => {
    return apiClient.post(`/admin/equipment/${playerId}/repair-all`);
};

/**
 * 删除装备记录（强制卸下，归还物品）
 * DELETE /admin/equipment/:playerId/record/:id
 */
export const deleteEquipmentRecord = (playerId: number, recordId: number) => {
    return apiClient.delete(`/admin/equipment/${playerId}/record/${recordId}`);
};
