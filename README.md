# Jungle — núcleo financeiro

Implementação incremental do [desafio oficial](https://github.com/junglegaming/backend-challenge). O enunciado original está preservado em [docs/CHALLENGE.md](docs/CHALLENGE.md).

Etapa 1: wallets, abertura com `OPENING`, `BET`, `WIN`, `LOSS`, ledger imutável, idempotência persistente e concorrência por wallet. **Ainda não é a entrega completa do desafio.** Reversões, referências, SQS, inbox/outbox, workers, reconciliação e observabilidade completa estão pendentes.

## Executar

Requisitos: Bun **1.3.14**, Docker e Docker Compose v2. A aplicação usa NestJS 11, TypeORM e PostgreSQL 18. Não há autenticação nesta etapa; use apenas em ambiente local.

```sh
bun install --frozen-lockfile
docker compose up -d --wait postgres
```

Copie `.env.example` para `.env` (`cp .env.example .env` ou `Copy-Item .env.example .env` no PowerShell). Ajuste a porta/URL se já houver PostgreSQL na porta 5432. Bun carrega `.env` automaticamente.

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

`build` gera `dist/`; `start` executa o fonte com Bun. Para executar a saída compilada: `bun dist/main.js`. A reversão da migration remove as tabelas financeiras: execute apenas em banco descartável ou antes de haver dados que precisem ser preservados.

## Testar

```sh
bun run typecheck
bun run build
bun test test/unit
docker compose --profile test up -d --wait postgres-test
bun run test:integration
```

`TEST_DATABASE_URL` deve apontar para um banco separado cujo nome termine em `_test`. O valor de `.env.example` usa a porta **5433**. Os testes criam e removem seu próprio schema e não usam mocks do PostgreSQL. O usuário de teste precisa poder criar schemas. Sem a variável, a suíte falha explicitamente.

São cobertos: precisão decimal, transições terminais, abertura, `BET/WIN/LOSS`, saldo insuficiente, conflitos de moeda/player, replay com saldo original, duplicação concorrente em três pools independentes, disputa `80 + 80` sobre `100`, rollback após falha injetada no ledger, constraints, imutabilidade, contratos HTTP, timeout de lock com retry e paginação. O teardown reverte e reaplica a migration.

Os testes com três pools não comprovam execução em três processos. Testes com SQS, três processos, morte após commit/antes de ack e recuperação de workers pertencem às próximas etapas.

Validação desta etapa em Windows, Bun 1.3.14 e PostgreSQL 18.4 local: instalação com lockfile congelado, typecheck, build, **24 testes unitários e 11 de integração aprovados**. Os comandos de migration (aplicação, reaplicação e reversão) e a API compilada também foram executados. Docker/Compose não foram executados porque Docker não está instalado neste ambiente. O Bun usado aqui foi instalado somente em `.local/bun`, pasta ignorada pelo Git; instale a versão indicada no seu PATH para usar os comandos acima.

## API implementada

| Método | Caminho | Resultado |
| --- | --- | --- |
| POST | `/wallets` | Cria wallet; crédito inicial positivo gera `OPENING` e ledger |
| GET | `/wallets/:walletId` | Saldo atual e versão |
| GET | `/wallets/:walletId/ledger?limit=50&cursor=...` | Ledger crescente por sequência; cursor opaco |
| POST | `/wagering/transactions` | Processa `BET`, `WIN` ou `LOSS` |
| GET | `/wagering/transactions/:transactionId` | Consulta operação e saldo original |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pela identidade externa |

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

Valores monetários são strings com **exatamente duas casas**, entre `0.00` e `999999999999999999.99`. A API aceita apenas BRL; o domínio suporta operações entre valores da mesma moeda. `BET` e `WIN` exigem valor positivo. `LOSS` admite valor não negativo e nunca movimenta saldo nem gera ledger. `OPENING` e o provider `__internal__` são reservados. Referências e reversões são recusadas nesta etapa.

| HTTP | Significado |
| --- | --- |
| 201 | Wallet criada |
| 200 | Consulta, operação aplicada ou replay de operação aplicada |
| 400 | Payload, header, ID ou cursor inválido; operação ainda não suportada |
| 404 | Wallet/transação inexistente |
| 409 | Wallet duplicada ou conflito de identidade/idempotência |
| 422 | Rejeição de negócio persistida; replay conserva o mesmo resultado |
| 503 | Falha transitória de infraestrutura reconhecida; reenviar com a mesma chave |
| 500 | Erro inesperado |

As decisões, códigos de falha e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).
