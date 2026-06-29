process.env.NEERU_CONTRACT_ADDRESS =
  process.env.NEERU_CONTRACT_ADDRESS ??
  '0x000000000000000000000000000000000000beef'

process.env.NEERU_EVENT_A_TOPIC0 =
  process.env.NEERU_EVENT_A_TOPIC0 ??
  '0x1111111111111111111111111111111111111111111111111111111111111111'

process.env.NEERU_EVENT_B_TOPIC0 =
  process.env.NEERU_EVENT_B_TOPIC0 ??
  '0x2222222222222222222222222222222222222222222222222222222222222222'

process.env.NEERU_EVENT_C_TOPIC0 =
  process.env.NEERU_EVENT_C_TOPIC0 ??
  '0x3333333333333333333333333333333333333333333333333333333333333333'

process.env.NEERU_EVENT_D_TOPIC0 =
  process.env.NEERU_EVENT_D_TOPIC0 ??
  '0x4444444444444444444444444444444444444444444444444444444444444444'

process.env.NEERU_INDEXER_GENESIS_BLOCK =
  process.env.NEERU_INDEXER_GENESIS_BLOCK ?? '1000'

process.env.NEERU_DEPOSIT_TOKEN_ADDRESS =
  process.env.NEERU_DEPOSIT_TOKEN_ADDRESS ??
  '0x000000000000000000000000000000000000c0fe'

process.env.NEERU_TRANCHE_IMAGE_URL_TEMPLATE =
  process.env.NEERU_TRANCHE_IMAGE_URL_TEMPLATE ??
  'https://cdn.example.test/neeru/tranche-{N}.png'

process.env.NEERU_MANAGE_URL =
  process.env.NEERU_MANAGE_URL ?? 'https://neerufinance.test/'

process.env.NEERU_TERMS_URL =
  process.env.NEERU_TERMS_URL ?? 'https://neerufinance.test/terms'

process.env.NEERU_CONTRACT_CREATED_AT_ISO =
  process.env.NEERU_CONTRACT_CREATED_AT_ISO ?? '2026-06-01T00:00:00.000Z'

// Disable the WRI per-IP and global rate-limit tiers by default in jest so
// the existing test suite (which sends many requests against the same mocked
// IP and against null Redis) keeps working. Tests that exercise the new
// tiers set these env vars locally inside their describe block.
process.env.WRI_RELAY_PER_IP_LIMIT = process.env.WRI_RELAY_PER_IP_LIMIT ?? '0'
process.env.WRI_RELAY_GLOBAL_LIMIT = process.env.WRI_RELAY_GLOBAL_LIMIT ?? '0'
