/**
 * 采集 API（脚下资源格）
 */
import apiClient from './index'

export const listMapResources = () => apiClient.get('/gather/resources')

export const collectResource = (resourceId: string) =>
  apiClient.post('/gather/collect', { resource_id: resourceId, resourceId })

export const batchCollect = (resourceId: string, count: number) =>
  apiClient.post('/gather/batch-collect', { resourceId, count })
