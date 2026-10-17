# Jungle — núcleo financeiro

Implementação incremental do [desafio oficial](https://github.com/junglegaming/backend-challenge). O enunciado original está preservado em [docs/CHALLENGE.md](docs/CHALLENGE.md).

Etapas 1 e 2: wallets, `OPENING`, `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`, ledger imutável, idempotência persistente, concorrência por wallet, referências fora de ordem e reconciliação. **Ainda não é a entrega completa do desafio.** SQS, inbox/outbox e observabilidade completa estão pendentes.

## Executar

Requisitos: Bun **1.3.14**, Docker e Docker Compose v2. A aplicação usa NestJS 11, TypeORM e PostgreSQL 18. Não há autenticação nesta etapa; use apenas em ambiente local.

```sh
bun install --frozen-lockfile
docker compose up -d --wait postgres
```

Copie `.env.example` para `.env` (`cp .env.example .env` ou `Copy-Item .env.example .env` no PowerShell). O PostgreSQL do Compose usa a porta externa **55432**; a comunicação entre containers usa `postgres:5432`. Bun carrega `.env` automaticamente.

```sh
bun run migration:run
bun run dev
```

API em `http://localhost:3000`. Para iniciar tudo em containers:

```sh
docker compose up --build -d
```

O container aplica migrations antes de iniciar a API. Nesta etapa, use uma única instância para executar migrations; no deploy com múltiplas instâncias, execute-as separadamente uma vez.

```sh
bun run build
bun run start
bun run migration:revert
```

`build` gera `dist/`; `start` executa o fonte com Bun. Para executar a saída compilada: `bun dist/main.js`. `migration:revert` desfaz somente a última migration. A migration de referências pode ser revertida enquanto houver apenas histórico da Etapa 1; recusa a reversão quando já existem referências/reversões, para preservar a auditoria. A migration inicial remove as tabelas financeiras ao ser revertida.

## Testar

```sh
bun run typecheck
bun run build
bun test test/unit
docker compose --profile test up -d --wait postgres-test
bun run test:integration
```

`TEST_DATABASE_URL` deve apontar para um banco separado cujo nome termine em `_test`. O valor de `.env.example` usa a porta **5433**. Os testes criam e removem seu próprio schema e não usam mocks do PostgreSQL. O usuário de teste precisa poder criar schemas. Sem a variável, a suíte falha explicitamente.

São cobertos: precisão decimal, transições, todas as operações, saldo insuficiente, identidade e validade de referências, replay com saldo original, duplicação e reversões concorrentes em três pools independentes, disputa `80 + 80` sobre `100`, falhas injetadas, constraints, imutabilidade, contratos HTTP, timeout de lock e paginação. Os novos testes incluem workers concorrentes, backoff/expiração, referências encadeadas, reconciliação concorrente/divergente e migration down/up preservando histórico anterior.

Os testes com três pools não comprovam execução em três processos. Testes com SQS, três processos, morte após commit/antes de ack e recuperação de workers pertencem às próximas etapas.

Validação da Etapa 2 em Windows, Bun 1.3.14 e PostgreSQL 18.1 em container: typecheck, build, **33 testes unitários e 35 de integração aprovados**, preservando os 35 testes anteriores. A imagem foi construída e a API compilada foi validada no Compose por HTTP: REFUND, ROLLBACK sobre BET/WIN/REFUND, resolução automática de pendência, replay, rejeição de saldo negativo e reconciliação. A migration preservou a wallet e o lançamento existentes. O Bun local está em `.local/bun`, pasta ignorada pelo Git; instale a versão indicada no PATH para usar os comandos acima.

## API implementada

| Método | Caminho | Resultado |
| --- | --- | --- |
| POST | `/wallets` | Cria wallet; crédito inicial positivo gera `OPENING` e ledger |
| GET | `/wallets/:walletId` | Saldo atual e versão |
| GET | `/wallets/:walletId/ledger?limit=50&cursor=...` | Ledger crescente por sequência; cursor opaco |
| POST | `/wagering/transactions` | Processa `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK` |
| GET | `/wagering/transactions/:transactionId` | Consulta operação e saldo original |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pela identidade externa |
| POST | `/wallets/:walletId/reconciliation` | Compara saldo armazenado com a soma do ledger |
| GET | `/metrics` | Contador de divergências de reconciliação em formato Prometheus |

Criar wallet:

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

Enviar aposta para `POST /wagering/transactions`, com header obrigatório `Idempotency-Key: provider-a:transaction-123`. Substitua `walletId` pelo ID retornado na criação:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "80.00", "currency": "BRL" }
}
```

Valores monetários são strings com **exatamente duas casas**, entre `0.00` e `999999999999999999.99`. A API aceita apenas BRL; o domínio suporta operações entre valores da mesma moeda. Operações financeiras exigem valor positivo. `LOSS` admite valor não negativo e nunca movimenta saldo nem gera ledger. `OPENING` e o provider `__internal__` são reservados.

Para reverter uma aposta, envie os mesmos campos de identidade/rodada, um novo `externalTransactionId` e uma nova chave, com `kind: "REFUND"` e `referenceExternalTransactionId: "transaction-123"`. O valor deve ser integral e igual ao da referência. `ROLLBACK` aceita BET, WIN ou REFUND e inverte seu efeito; REFUND aceita somente BET. Cada referência admite uma reversão por tipo, conforme o enunciado. WIN aceita referência opcional a BET, sem exigir valor igual ao da aposta.

Uma referência ainda ausente retorna **202 / PENDING_REFERENCE**, com `transactionId`, saldo observado na aceitação, `referenceAttempts` e `nextAttemptAt`. Consulte a transação pelo ID para acompanhar. O worker inicia com a aplicação, verifica pendências a cada segundo e usa até oito tentativas agendadas: intervalos de 5, 10, 20, 40, 80, 160, 300 e 300 segundos. O cronograma e as tentativas ficam no PostgreSQL. Em execução local com Bun, `REFERENCE_WORKER_ENABLED=false` desativa o agendador para testes ou manutenção.

A reconciliação retorna `walletId`, `storedBalance`, `calculatedBalance`, `difference` (armazenado menos calculado), `consistent` e `checkedEntries`. Usa um único snapshot SQL, não altera saldos e registra divergências no log e em `wallet_reconciliation_divergences_total`.

| HTTP | Significado |
| --- | --- |
| 201 | Wallet criada |
| 200 | Consulta, operação aplicada ou replay de operação aplicada |
| 202 | Referência pendente; inclusive replay enquanto aguarda resolução |
| 400 | Payload, referência obrigatória, header, ID ou cursor inválido |
| 404 | Wallet/transação inexistente |
| 409 | Wallet duplicada ou conflito de identidade/idempotência |
| 422 | Rejeição de negócio persistida; replay conserva o mesmo resultado |
| 503 | Falha transitória de infraestrutura reconhecida; reenviar com a mesma chave |
| 500 | Erro inesperado |

As decisões, códigos de falha e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).
