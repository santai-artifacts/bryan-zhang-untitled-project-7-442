import { Hono } from 'hono'
import Database from 'bun:sqlite'
import { mkdirSync } from 'fs'

try { mkdirSync('./data', { recursive: true }) } catch {}

const db = new Database(process.env.DATABASE_URL || './data/app.db')
db.exec(`
  CREATE TABLE IF NOT EXISTS journeys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    distance REAL NOT NULL,
    passengers INTEGER NOT NULL,
    completed_at TEXT DEFAULT (datetime('now'))
  )
`)

const { count } = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM journeys').get()!
if (count === 0) {
  db.exec(`
    INSERT INTO journeys (distance, passengers) VALUES (287.4, 143);
    INSERT INTO journeys (distance, passengers) VALUES (156.2, 89);
    INSERT INTO journeys (distance, passengers) VALUES (412.8, 201);
    INSERT INTO journeys (distance, passengers) VALUES (93.5, 47);
    INSERT INTO journeys (distance, passengers) VALUES (334.1, 178);
  `)
}

const app = new Hono()

app.get('/api/stats', (c) => {
  const stats = db.query<{
    total_journeys: number
    total_distance: number
    total_passengers: number
    longest_journey: number
  }, []>(`
    SELECT
      COUNT(*) as total_journeys,
      ROUND(COALESCE(SUM(distance), 0), 1) as total_distance,
      COALESCE(SUM(passengers), 0) as total_passengers,
      ROUND(COALESCE(MAX(distance), 0), 1) as longest_journey
    FROM journeys
  `).get()!
  return c.json(stats)
})

app.post('/api/journey', async (c) => {
  const { distance, passengers } = await c.req.json<{ distance: number; passengers: number }>()
  db.query('INSERT INTO journeys (distance, passengers) VALUES (?, ?)').run(
    Math.round(distance * 10) / 10,
    passengers
  )
  return c.json({ success: true })
})

app.get('/', (c) => {
  return new Response(Bun.file(`${import.meta.dir}/public/index.html`))
})

export default { port: process.env.PORT || 3000, fetch: app.fetch }
