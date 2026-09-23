import apiClient from './index'

export interface SwordArtStatus {
  global: Record<string, unknown>
  arts: Array<Record<string, unknown>>
  formations: Array<Record<string, unknown>>
}

export function getSwordArtInfo() {
  return apiClient.get<{ global: Record<string, unknown>; manuals: Array<Record<string, unknown>>; formations: Array<Record<string, unknown>> }>('/sword-art/info')
}
export function getSwordArtStatus() {
  return apiClient.get<SwordArtStatus>('/sword-art/status')
}
export function composeSwordArt(manual_id: string) {
  return apiClient.post<Record<string, unknown>>('/sword-art/compose', { manual_id })
}
export function comprehendSwordArt(manual_id: string) {
  return apiClient.post<Record<string, unknown>>('/sword-art/comprehend', { manual_id })
}
export function refineSwordArt(manual_id: string) {
  return apiClient.post<Record<string, unknown>>('/sword-art/refine', { manual_id })
}
export function inspectSwordFormation(formation_id: string) {
  return apiClient.post<Record<string, unknown>>('/sword-art/formation/inspect', { formation_id })
}
export function deploySwordFormation(formation_id: string) {
  return apiClient.post<Record<string, unknown>>('/sword-art/formation/deploy', { formation_id })
}
