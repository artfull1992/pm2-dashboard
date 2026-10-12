# Архітектура GOIT Node Control

Стан перевірено за кодом 2026-10-12. Документ розрізняє реалізацію Task 001 і ціль MVP1.

## Реалізовано

ES modules, залежність `pg`, npm scripts, вбудований `node:test`. `backend/`, `frontend/`, `agent/` містять лише `.gitkeep`. API, UI, агенти, схема прикладних таблиць, міграції, systemd units та Nginx-конфігурації проєкту відсутні.

| Шлях | Фактична відповідальність |
|---|---|
| `scripts/setup-postgres.js` | Запуск від root на хості БД: роль, БД, ACL, `.env`, додавання HBA-правила та reload |
| `scripts/db-check.js` | Підключення з `.env`, SELECT 1, показ версії й факту SSL |
| `scripts/check-secrets.js` | Перевірка `.env` у Git і сканування файлів, що можуть потрапити в commit |
| `scripts/lib/` | Конфігурація, env, генерація пароля, SCRAM, SQL builders, HBA parser, setup plan, scanner |
| `tests/unit/` | 46 тестів допоміжної логіки без БД |
| `tests/integration/` | Env, реальна БД, каталоги, права, SCRAM; привілейовані серверні перевірки |
| `docs/server-audit.md` | Історичний звіт Task 001 про сервер, не поточна незалежна перевірка |

`ENV_PATH` прив'язаний до кореня checkout; `/etc/pm2-dashboard/.env` отримується лише якщо код розміщено в цьому каталозі. Setup використовує DB_NAME/DB_USER із config та відмовляється змінювати БД з чужим власником. Повторний запуск примусово застосовує атрибути ролі та ACL; це не повний no-op. Пароль змінюється лише при створенні ролі або явному `--rotate-password`; `.env` записується до зміни пароля.

HBA-правило в коді: `hostssl node_control_db node_control_user 0.0.0.0/0 scram-sha-256`. Воно обмежене БД/роллю, але дозволяє будь-яку IPv4-адресу. Попередні правила HBA можуть збігтися раніше. `dbConfigFromEnv` не задає `ssl`; перевірка SCRAM не є перевіркою TLS. Публічний доступ не дозволений архітектурою без окремого підтвердження.

## Ціль MVP1 — ще не реалізовано

```mermaid
flowchart LR
  User[Користувач] --> Nginx[Nginx на хості / TLS]
  Nginx --> UI[React + Vite]
  Nginx --> API[Fastify Central API / REST + WebSocket]
  Agent[Node.js Agent / systemd] -->|Вихідне захищене з'єднання| API
  Agent --> PM2[Локальний PM2 API]
  API --> DB[PostgreSQL на хості]
  API --> Jenkins[Існуючий Jenkins API / pipelines]
  API --> Slack[Slack Alerts]
  API --> менеджер секретів[Існуючий менеджер секретів]
```

Central API: authentication, authorization, реєстри серверів і застосунків, Audit Logs, Alerts Engine, Jenkins integration. Frontend: Dashboard, Servers, Applications, Logs, Metrics, Deployments, Settings. Agent: PM2-процеси, CPU/RAM застосунків і сервера, потік логів, Start/Stop/Restart через обмежений протокол операцій.

MVP1 охоплює кілька серверів, моніторинг, логи в реальному часі, керування процесами, redeploy, доступ за ролями та аудит усіх адміністративних дій. Slack: зупинка процесу, недоступність сервера, високі CPU/RAM, часті рестарти, невдалий деплой і відновлення; обов'язкові cooldown та deduplication.

Транспорт агента, формат команд, модель ролей, retention метрик/логів, схема БД та міграційний інструмент ще не обрані. Не видавати їх за прийняті рішення.
