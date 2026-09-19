/**
 * 成就系统 API 封装
 * 对应后端 /api/achievement 路由。
 * 直接基于 axios（与项目其它 api 文件保持一致）。
 */
import apiClient from './index'

const BASE = '/achievement'

/**
 * 获取成就总览（含玩家进度 / 是否达成 / 是否已领奖）
 */
export const getAchievements = () => apiClient.get(`${BASE}/list`)

/**
 * 领取成就奖励
 * @param achievementId 成就ID
 */
export const claimAchievement = (achievementId: string) =>
  apiClient.post(`${BASE}/claim`, { achievement_id: achievementId })
