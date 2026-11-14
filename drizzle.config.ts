import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/server/db/schema.ts',
    './src/server/db/likes-schema.ts',
    './src/server/db/rooms-schema.ts',
  ],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
