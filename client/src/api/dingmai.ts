import apiClient from './index'

export function getDingmaiInfo() {
  return apiClient.get<Record<string, unknown>>('/dingmai/info')
}
export function getDingmaiStatus() {
  return apiClient.get<Record<string, unknown>>('/dingmai/status')
}
export function actDingmai(action: string, element?: string) {
  return apiClient.post<Record<string, unknown>>('/dingmai/act', { action, element })
}
