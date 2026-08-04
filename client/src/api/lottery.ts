/**
 * 抽奖（寻仙机缘）系统 API 封装
 * 对应后端 /api/lottery 路由。
 * 直接基于 axios（与项目其它 api 文件保持一致）。
 */
import axios from 'axios'

const BASE = '/api/lottery'

/**
 * 获取抽奖面板信息（花费 / 保底 / 奖池预览 / 玩家保底进度）
 */
export const getLotteryPanel = () => axios.get(`${BASE}/panel`)

/**
 * 抽奖
 * @param mode 'single' | 'ten'
 */
export const drawLottery = (mode: 'single' | 'ten' = 'single') =>
  axios.post(`${BASE}/draw`, { mode })
