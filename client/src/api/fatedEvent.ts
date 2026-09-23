import apiClient from './index'

export interface FatedStatus {
  active: Record<string, unknown> | null
  recent: Array<Record<string, unknown>>
}

export function getFatedInfo() {
  return apiClient.get<{ global: Record<string, unknown>; events: Array<Record<string, unknown>> }>('/fated-event/info')
}
export function getFatedStatus() {
  return apiClient.get<FatedStatus>('/fated-event/status')
}
export function triggerFatedEvent(event_id?: string) {
  return apiClient.post<Record<string, unknown>>('/fated-event/trigger', { event_id })
}
export function chooseFatedEvent(choice_id: string) {
  return apiClient.post<Record<string, unknown>>('/fated-event/choose', { choice_id })
}
