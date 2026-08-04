/**
 * 成就系统 API 封装
 * 对应后端 /api/achievement 路由。
 * 直接基于 axios（与项目其它 api 文件保持一致）。
 */
import axios from 'axios'

const BASE = '/api/achievement'

/**
 * 获取成就总览（含玩家进度 / 是否达成 / 是否已领奖）
 */
export const getAchievements = () => axios.get(`${BASE}/list`)

/**
 * 领取成就奖励
 * @param achievementId 成就ID
 */
export const claimAchievement = (achievementId: string) =>
  axios.post(`${BASE}/claim`, { achievement_id: achievementId })
