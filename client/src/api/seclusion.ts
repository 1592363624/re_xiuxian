/**
 * 闭关相关 API
 *
 * 重构后支持两种闭关模式：
 *   - normal：常规闭关，短时多次，适合日常修炼
 *   - deep：深度闭关，长线挂机，2 倍收益，需筑基期以上
 */
import apiClient from './index';

/**
 * 闭关模式类型
 *   - normal：常规闭关（默认）
 *   - deep：深度闭关（需筑基期以上）
 */
export type SeclusionMode = 'normal' | 'deep';

/**
 * 获取闭关状态
 * 后端返回：模式、进度、每日剩余次数、配置信息等
 */
export const getStatus = () => {
  return apiClient.get('/seclusion/status');
};

/**
 * 开始闭关
 * @param mode - 闭关模式 normal|deep（默认 normal）
 * @param duration - 期望闭关时长（秒），可选；深度闭关 4-8 小时，常规闭关最长 30 分钟
 */
export const start = (mode: SeclusionMode = 'normal', duration?: number) => {
  return apiClient.post('/seclusion/start', { mode, duration });
};

/**
 * 结束闭关（正常结算）
 * 深度闭关未达最短时长时按强行出关处理，损失 forced_penalty 比例收益
 */
export const end = () => {
  return apiClient.post('/seclusion/end');
};

/**
 * 强行出关（深度闭关专用快捷接口）
 * 逻辑等同 /end，仅作为语义上的快捷入口
 */
export const forceEnd = () => {
  return apiClient.post('/seclusion/force-end');
};
