# Security and credentials

Keep your Predictefy API key in a local `.env` file or process environment. Never commit `.env`, upload it in an issue, or include it in a screenshot. The repository contains only `.env.example` with a placeholder.

The tracker binds to `127.0.0.1` and is intended to run on your own computer. The browser receives public market data; authenticated upstream requests happen in the Node process. Do not expose this local dashboard to the internet without adding authentication and reviewing the deployment.

The tracker does not need a Polymarket private key, seed phrase, funded wallet, or order permission. Do not add these to its configuration.

If you expose an API key, revoke or rotate it through your provider account. Removing it from the latest file alone does not remove it from Git history.

For a suspected vulnerability, use the repository's private vulnerability reporting option under **Security → Report a vulnerability**. Use synthetic values in reproductions and avoid publishing credentials. Ordinary bugs can be reported in public issues with redacted output.
