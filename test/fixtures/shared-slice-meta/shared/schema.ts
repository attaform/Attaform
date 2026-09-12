import { z } from 'zod'
import { fieldMeta } from 'attaform'

export const schema = z.object({
  firstName: z.string().min(1).register(fieldMeta, { label: 'Given name' }),
})
