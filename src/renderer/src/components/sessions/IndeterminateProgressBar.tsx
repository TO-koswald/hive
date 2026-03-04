import { cn } from '@/lib/utils'
import type { SessionMode } from '@/stores/useSessionStore'

interface IndeterminateProgressBarProps {
  mode: SessionMode
  className?: string
}

export function IndeterminateProgressBar({ mode, className }: IndeterminateProgressBarProps) {
  const isBuild = mode === 'build'

  return (
    <div
      role="progressbar"
      aria-label="Agent is working"
      className={cn(
        'relative w-36 h-4 rounded-full overflow-hidden',
        isBuild ? 'bg-blue-500/15' : 'bg-violet-500/15',
        className
      )}
    >
      <div
        className={cn(
          'progress-bounce-bar absolute top-0 bottom-0 rounded-full',
          isBuild ? 'bg-blue-500' : 'bg-violet-500'
        )}
        style={{ animation: 'progress-bounce 3s linear infinite' }}
      />
    </div>
  )
}
