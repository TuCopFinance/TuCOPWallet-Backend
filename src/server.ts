import { app } from './app'

const PORT = Number(process.env.PORT) || 8080

if (!process.env.ETHERSCAN_API_KEY) {
  console.error('FATAL: ETHERSCAN_API_KEY env var is required')
  process.exit(1)
}

app.listen(PORT, () => {
  console.log(`tucopwallet-backend listening on :${PORT}`)
})
