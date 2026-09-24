/**
 * 系统任务「尘缘指归」API
 * 对应后端 /api/system-quest。
 */
import apiClient from './index'

const BASE = '/system-quest'

export const getSystemQuestBoard = () => apiClient.get(`${BASE}/board`)

export const getSystemQuestCurrent = () => apiClient.get(`${BASE}/current`)

export const syncSystemQuest = () => apiClient.post(`${BASE}/sync`)
