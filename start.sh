#!/bin/bash
# Launch script: start local anvil, deploy all games, then backend.
# For Base Sepolia, set RPC_HTTP_URL / PRIVATE_KEY and skip anvil.

set -e

ROOT="/Users/dindi/Documents/Code/web3_games"
cd "$ROOT"

export PATH="$HOME/.foundry/bin:$PATH"

# Load .env if present
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Defaults for local Anvil
export RPC_HTTP_URL="${RPC_HTTP_URL:-http://127.0.0.1:8545}"
export RPC_WS_URL="${RPC_WS_URL:-ws://127.0.0.1:8545}"
export PRIVATE_KEY="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
export HOUSE_ADDRESS="${HOUSE_ADDRESS:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"
export BLOCKS_PER_ROUND="${BLOCKS_PER_ROUND:-5}"
export COLOR_DUEL_BLOCKS_PER_ROUND="${COLOR_DUEL_BLOCKS_PER_ROUND:-1}"
export CRASH_BLOCKS_PER_ROUND="${CRASH_BLOCKS_PER_ROUND:-1}"
export PLINKO_BLOCKS_PER_ROUND="${PLINKO_BLOCKS_PER_ROUND:-1}"
export ROULETTE_BLOCKS_PER_ROUND="${ROULETTE_BLOCKS_PER_ROUND:-1}"
export COIN_FLIP_BLOCKS_PER_ROUND="${COIN_FLIP_BLOCKS_PER_ROUND:-1}"
export SLOTS_BLOCKS_PER_ROUND="${SLOTS_BLOCKS_PER_ROUND:-1}"
export HORSE_RACE_BLOCKS_PER_ROUND="${HORSE_RACE_BLOCKS_PER_ROUND:-3}"
export KENO_BLOCKS_PER_ROUND="${KENO_BLOCKS_PER_ROUND:-1}"
export BINGO_BLOCKS_PER_ROUND="${BINGO_BLOCKS_PER_ROUND:-5}"
export MINEFIELD_BLOCKS_PER_ROUND="${MINEFIELD_BLOCKS_PER_ROUND:-1}"
export HOUSE_EDGE_BPS="${HOUSE_EDGE_BPS:-500}"
export SETTLEMENT_BOUNTY_BPS="${SETTLEMENT_BOUNTY_BPS:-10}"
export PORT="${PORT:-8090}"
export HOST="${HOST:-0.0.0.0}"

ANVIL_PID=""

# Start anvil if we're targeting local
if [[ "$RPC_HTTP_URL" == *"127.0.0.1:8545"* || "$RPC_HTTP_URL" == *"localhost:8545"* ]]; then
  echo "Starting local Anvil..."
  anvil --port 8545 --block-time 2 > "$ROOT/anvil.log" 2>&1 &
  ANVIL_PID=$!
  sleep 2
fi

# Build and deploy
echo "Building contracts..."
cd "$ROOT/contract"
forge build

echo "Deploying all games..."
OUTPUT=$(forge script script/Deploy.s.sol --rpc-url "$RPC_HTTP_URL" --private-key "$PRIVATE_KEY" --broadcast 2>&1)
echo "$OUTPUT"

# Update config.yaml with all deployed addresses
python3 - "$ROOT/config.yaml" "$OUTPUT" <<'PY'
import re, sys
config_path, output = sys.argv[1], sys.argv[2]

mapping = {
    'DiceGame deployed at:': 'dice',
    'ColorDuelGame deployed at:': 'color-duel',
    'CrashGame deployed at:': 'crash',
    'PlinkoGame deployed at:': 'plinko',
    'RouletteGame deployed at:': 'roulette',
    'CoinFlipStreakGame deployed at:': 'coin-flip',
    'SlotsGame deployed at:': 'slots',
    'HorseRaceGame deployed at:': 'horse-race',
    'KenoGame deployed at:': 'keno',
    'BlockBingoGame deployed at:': 'block-bingo',
    'MinefieldGame deployed at:': 'minefield',
}

addresses = {}
for prefix, key in mapping.items():
    m = re.search(re.escape(prefix) + r'\s*(0x[0-9a-fA-F]+)', output)
    if m:
        addresses[key] = m.group(1)

with open(config_path, 'r') as f:
    text = f.read()

# Replace or insert contract addresses block
def build_block(addrs):
    lines = ['contracts:']
    order = ['dice','color-duel','crash','plinko','roulette','coin-flip','slots','horse-race','keno','block-bingo','minefield']
    for k in order:
        lines.append(f'  {k}: "{addrs.get(k, "")}"')
    return '\n'.join(lines)

if re.search(r'^contracts:', text, flags=re.M):
    text = re.sub(
        r'^contracts:.*?\n(?=\S|\n#|faucet:|\Z)',
        build_block(addresses) + '\n',
        text,
        count=1,
        flags=re.S | re.M,
    )
else:
    text = text.rstrip() + '\n\n' + build_block(addresses) + '\n'

with open(config_path, 'w') as f:
    f.write(text)

print('Updated config.yaml with', len(addresses), 'contract addresses')
PY

# Configure contracts for easy local testing
GAME_CONTRACTS=(
  "dice"
  "color-duel"
  "crash"
  "plinko"
  "roulette"
  "coin-flip"
  "slots"
  "horse-race"
  "keno"
  "block-bingo"
  "minefield"
)
for key in "${GAME_CONTRACTS[@]}"; do
  ADDR=$(python3 -c "import yaml; print(yaml.safe_load(open('$ROOT/config.yaml'))['contracts']['$key'])")
  if [ -n "$ADDR" ] && [ "$ADDR" != "None" ]; then
    cast send "$ADDR" "setMinPool(uint256)" 0 --rpc-url "$RPC_HTTP_URL" --private-key "$PRIVATE_KEY" >/dev/null
    cast send "$ADDR" "setMinBettors(uint256)" 1 --rpc-url "$RPC_HTTP_URL" --private-key "$PRIVATE_KEY" >/dev/null
    cast send "$ADDR" "setMinBet(uint256)" 100000000000000 --rpc-url "$RPC_HTTP_URL" --private-key "$PRIVATE_KEY" >/dev/null
    echo "Configured $key at $ADDR"
  fi
done

# Activate venv and start backend
cd "$ROOT"
if [ ! -d .venv ]; then
  uv venv .venv
fi
source .venv/bin/activate
uv pip install -r backend/requirements.txt

echo "Starting FastAPI backend on port ${PORT:-8090}..."
uvicorn backend.main:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8090}" &
BACKEND_PID=$!

echo ""
echo "Frontend: http://localhost:8090"
echo "Backend PID: $BACKEND_PID"
[ -n "$ANVIL_PID" ] && echo "Anvil PID: $ANVIL_PID"
echo "Press Ctrl+C to stop"

cleanup() {
  echo "Stopping..."
  kill $BACKEND_PID 2>/dev/null || true
  [ -n "$ANVIL_PID" ] && kill $ANVIL_PID 2>/dev/null || true
  exit
}
trap cleanup INT
wait
