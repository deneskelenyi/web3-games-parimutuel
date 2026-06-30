"""
Configuration loader. Reads config.yaml from the project root and merges optional .env overrides.
"""

import os
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

load_dotenv()

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.yaml"


def load_config() -> dict[str, Any]:
    with CONFIG_PATH.open("r") as f:
        cfg = yaml.safe_load(f) or {}

    cfg.setdefault("network", "anvil")
    cfg.setdefault("chain_id", 31337)
    cfg.setdefault("rpc_http_url", os.getenv("RPC_HTTP_URL", "http://127.0.0.1:8545"))
    cfg.setdefault("rpc_ws_url", os.getenv("RPC_WS_URL", "ws://127.0.0.1:8545"))
    cfg.setdefault("host", os.getenv("HOST", "0.0.0.0"))
    cfg.setdefault("port", int(os.getenv("PORT", 8090)))
    cfg.setdefault("contracts", {})
    cfg.setdefault("defaults", {})
    cfg.setdefault("faucet", {})
    cfg.setdefault("auto_settle", cfg.get("network") == "anvil")
    cfg.setdefault("auto_settle_interval", 3.0)

    # Env overrides take precedence
    for key in ["network", "rpc_http_url", "rpc_ws_url"]:
        env_val = os.getenv(key.upper())
        if env_val:
            cfg[key] = env_val

    auto_settle_env = os.getenv("AUTO_SETTLE")
    if auto_settle_env is not None:
        cfg["auto_settle"] = auto_settle_env.lower() in ("1", "true", "yes", "on")

    port = os.getenv("PORT")
    if port:
        cfg["port"] = int(port)

    faucet_key = os.getenv("FAUCET_PRIVATE_KEY")
    if faucet_key:
        cfg.setdefault("faucet", {})["private_key"] = faucet_key

    return cfg


CONFIG = load_config()
