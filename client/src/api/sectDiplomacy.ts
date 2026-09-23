import apiClient from './index'

export function getSectDiplomacyInfo() {
  return apiClient.get<{ global: Record<string, unknown>; sects: Array<Record<string, unknown>> }>('/sect-diplomacy/info')
}
export function getWorldSituation() {
  return apiClient.get<Record<string, unknown>>('/sect-diplomacy/world')
}
export function getMySectRelations() {
  return apiClient.get<Record<string, unknown>>('/sect-diplomacy/mine')
}
export function actSectDiplomacy(target_sect_id: string, action: string) {
  return apiClient.post<Record<string, unknown>>('/sect-diplomacy/act', { target_sect_id, action })
}
