import { z } from 'zod'

export const schema = z.object({
  email: z.email('Enter a valid email'),
  profile: z.object({
    name: z.string().min(1, 'Name is required'),
    city: z.string(),
  }),
})

export type FormShape = z.infer<typeof schema>
