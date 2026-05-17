import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

crons.interval(
  'recover stuck uploading jobs',
  { minutes: 5 },
  internal.gemini.internalRecoverStuckJobs,
)

export default crons
