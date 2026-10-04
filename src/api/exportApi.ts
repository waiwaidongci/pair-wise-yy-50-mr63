import { activeStore } from '../stores/imposition'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Axios 风格模拟 REST 客户端。
 * 任务状态以 Pinia store 为唯一来源：list 读取、resume 触发分片续传、create 建立新交付包。
 */
export const exportApi = {
  list: async () => {
    await delay(180)
    return { data: structuredClone(activeStore().tasks), status: 200, statusText: 'OK', headers: {}, config: {} }
  },
  resume: async (id: string) => {
    await delay(420)
    const task = activeStore().resumeTask(id)
    return { data: structuredClone(task), status: 200, statusText: 'OK', headers: {}, config: {} }
  },
  create: async () => {
    await delay(180)
    return { data: structuredClone(activeStore().createTask()), status: 200, statusText: 'OK', headers: {}, config: {} }
  },
}
