/**
 * 功法系统前端 API 封装
 * 对应后端 server/routes/technique.js 暴露的 6 个接口：
 *   GET    /api/technique/list        获取功法总览（已习得 + 可习得 + 设置）
 *   POST   /api/technique/learn        习得 / 研习功法
 *   POST   /api/technique/practice     修炼（提升熟练度）
 *   POST   /api/technique/breakthrough 突破（升阶）
 *   POST   /api/technique/comprehend   领悟神通（针对某功法）
 *   POST   /api/technique/equip        装备 / 卸下功法（slot: main/auxiliary/null）
 *
 * 统一响应结构：{ code, data, message }。
 * 其中 list 的 data 为包装对象：{ settings, owned[], available[], wisdom }。
 */
import axios from 'axios'

/** 请求基础路径 */
const BASE = '/api/technique'

/** 获取功法总览（已习得 + 可习得 + 系统设置） */
export const getTechniqueList = () => axios.get(`${BASE}/list`)

/** 习得 / 研习指定功法 */
export const learnTechnique = (techniqueId: string) =>
  axios.post(`${BASE}/learn`, { technique_id: techniqueId })

/** 修炼指定功法：提升熟练度与修为 */
export const practiceTechnique = (techniqueId: string) =>
  axios.post(`${BASE}/practice`, { technique_id: techniqueId })

/** 突破指定功法：消耗资源升阶 */
export const breakthroughTechnique = (techniqueId: string) =>
  axios.post(`${BASE}/breakthrough`, { technique_id: techniqueId })

/** 针对指定功法领悟神通 */
export const comprehendTechnique = (techniqueId: string) =>
  axios.post(`${BASE}/comprehend`, { technique_id: techniqueId })

/**
 * 装备 / 卸下功法
 * @param techniqueId 功法ID
 * @param slot 目标槽位：'main' | 'auxiliary'；传 null/省略表示卸下当前装备
 */
export const equipTechnique = (techniqueId: string, slot?: 'main' | 'auxiliary' | null) =>
  axios.post(`${BASE}/equip`, { technique_id: techniqueId, slot: slot ?? null })
