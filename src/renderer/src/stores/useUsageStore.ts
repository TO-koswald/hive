import { create } from 'zustand'

interface UsageData {
  five_hour: { utilization: number; resets_at: string }
  seven_day: { utilization: number; resets_at: string }
  extra_usage?: {
    is_enabled: boolean
    utilization: number
    used_credits: number
    monthly_limit: number
  }
}

interface UsageState {
  usage: UsageData | null
  lastFetchedAt: number | null
  isLoading: boolean
  fetchUsage: () => Promise<void>
}

const DEBOUNCE_MS = 30_000

export const useUsageStore = create<UsageState>()((set, get) => ({
  usage: null,
  lastFetchedAt: null,
  isLoading: false,

  fetchUsage: async () => {
    const { isLoading, lastFetchedAt } = get()
    if (isLoading) return
    if (lastFetchedAt && Date.now() - lastFetchedAt < DEBOUNCE_MS) return

    set({ isLoading: true })
    try {
      const result = await window.usageOps.fetch()
      if (result.success) {
        set({ usage: result.data, lastFetchedAt: Date.now() })
      }
    } finally {
      set({ isLoading: false })
    }
  }
}))
