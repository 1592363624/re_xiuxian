/**
 * 管理员「立即完成」API（GM 测试加速专用）
 *
 * 用于把当前管理员自己进行中的「耗时操作」（闭关 / 静思悟道 / 历练）的时间戳前推，
 * 使其等同于「已按计划时长自然坐满」，从而在测试时跳过等待。
 *
 * 重要：本接口**只调时钟、不做结算**。调用后仍需照常走各自的结算入口：
 *   - 闭关：POST /seclusion/end（或 /seclusion/force-end）
 *   - 历练：POST /explore/complete
 *   - 悟道：POST /admin/meditation/:playerId/force-settle
 * 这样「加速后结算」与「自然到点结算」走同一条代码路径，收益与结果完全一致。
 *
 * 权限：仅管理员（后端 auth + adminCheck 双层校验，非管理员调用返回 403）。
 */
import apiClient from './index';

/** 可加速的耗时操作类型 */
export type QuickFinishState = 'seclusion' | 'meditation' | 'adventure';

/** 单项加速结果 */
export interface QuickFinishItem {
  /** 操作类型 */
  state: QuickFinishState;
  /** 计划时长（秒），闭关/悟道返回 */
  planned_seconds?: number;
  /** 模式（normal / deep），闭关/悟道返回 */
  mode?: string;
  /** 历练记录 ID，历练返回 */
  adventure_id?: number;
  /** 历练事件类型，历练返回 */
  event_type?: string | null;
}

/** 加速结果（POST /admin/quick-finish 返回） */
export interface QuickFinishResult {
  /** 本次被加速的操作列表，为空表示当前没有进行中的耗时操作 */
  finished: QuickFinishItem[];
  /** 服务端当前时间 */
  server_time: string;
}

/**
 * 加速当前管理员自己进行中的耗时操作
 * POST /admin/quick-finish
 *
 * @param state 可选，指定只加速某一项；不传则加速当前所有进行中的耗时操作
 */
export const quickFinish = (state?: QuickFinishState) => {
  return apiClient.post<QuickFinishResult>('/admin/quick-finish', state ? { state } : {});
};