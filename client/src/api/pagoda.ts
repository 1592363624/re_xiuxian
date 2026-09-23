import apiClient from './index'

export interface PagodaFloor {
  floor: number
  name: string
  description: string
  min_realm_rank: number
  stats: Record<string, number>
  rewards: Record<string, number>
  first_clear_bonus?: Record<string, unknown>
}

export interface PagodaStatus {
  highest_floor: number
  current_floor: number
  in_tower: boolean
  today_attempts: number
  daily_limit: number
  today_resets: number
  reset_daily_limit: number
  reset_cost_spirit_stones: number
  cooldown_sec: number
  last_attempt_at?: string
  best_score: number
  last_score: number
  total_clears: number
  first_clears: number[]
  next_floor: number
  can_climb: boolean
}

export interface ClimbResult {
  success: boolean
  result: string
  floor: number
  floor_name: string
  rounds_used: number
  score: number
  is_first_clear: boolean
  exp_gained: string
  spirit_stones_gained: string
  title_awarded?: string | null
  player_hp_remaining: string
  battle_log: string[]
  in_tower: boolean
  highest_floor: number
  next_floor: number | null
  message: string
}

export function getPagodaInfo() {
  return apiClient.get<{ global: Record<string, unknown>; floors: PagodaFloor[] }>('/pagoda/info')
}
export function getPagodaStatus() {
  return apiClient.get<PagodaStatus>('/pagoda/status')
}
export function getPagodaRanking(limit = 20) {
  return apiClient.get<{ ranking: Array<Record<string, unknown>> }>('/pagoda/ranking', { params: { limit } })
}
export function getPagodaHistory(limit = 20) {
  return apiClient.get<{ history: Array<Record<string, unknown>> }>('/pagoda/history', { params: { limit } })
}
export function climbPagoda() {
  return apiClient.post<ClimbResult>('/pagoda/climb')
}
export function exitPagoda() {
  return apiClient.post<{ message: string; highest_floor: number }>('/pagoda/exit')
}
export function resetPagoda() {
  return apiClient.post<{ message: string; spirit_stones_cost: string }>('/pagoda/reset')
}
