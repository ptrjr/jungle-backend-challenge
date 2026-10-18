# Jungle — processamento financeiro de apostas

Serviço para processar BET, WIN, LOSS, REFUND e ROLLBACK por HTTP ou SQS. Mantém saldo e ledger na mesma transação PostgreSQL, deduplica requisições e mensagens, reprocessa referências fora de ordem e publica eventos por transactional outbox.

Stack: Bun **1.3.14**, TypeScript strict, NestJS 11, TypeORM, PostgreSQL 18.1 e AWS SDK SQS. O ambiente local usa Docker Compose e LocalStack 4.10.0. O [enunciado](docs/CHALLENGE.md), as [decisões de arquitetura](ARCHITECTURE.md) e as [evidências de validação](docs/VALIDATION.md) complementam este guia.

## Executar com Docker Compose

Requer Docker Desktop/Engine com Compose v2. Crie `.env` a partir de `.env.example` se ainda não existir:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
docker compose up --build -d
```

Em shells Unix: `test -f .env || cp .env.example .env`. Se a porta 5432 estiver ocupada, configure `POSTGRES_PORT=55432` e a porta de `DATABASE_URL` no `.env`. Entre containers, PostgreSQL usa `postgres:5432`.

O Compose inicia banco, broker, inicialização das filas, API e workers. O container da API aplica as migrations antes de iniciar. API: `http://localhost:3000`; health: `/health/live` e `/health/ready`. Credenciais AWS são fictícias (`test/test`).

## Executar localmente com Bun

Com Bun 1.3.14 no PATH e `.env` configurado:

```sh
bun install --frozen-lockfile
docker compose up -d --wait postgres localstack
docker compose run --rm --no-deps sqs-init
bun run migration:run
bun run dev
```

Pare a API em container com `docker compose stop app` antes de usar a porta 3000 localmente. `bun run build` gera `dist/`; `bun dist/main.js` executa a saída compilada. `bun run start` executa o fonte sem watch. Para várias instâncias, aplique migrations uma vez antes de iniciar os processos.

`MESSAGING_ENABLED=true` habilita consumer e publisher. `REFERENCE_WORKER_ENABLED=false` desativa o worker de referências. A outbox é persistida mesmo com publicação desabilitada. `bun run migration:revert` desfaz uma migration; o comando recusa apagar histórico financeiro ou de entrega. O rollback completo exige schema vazio; veja as pré-condições na arquitetura.

## Criar uma wallet e apostar

Exemplo executável em PowerShell:

```powershell
$playerId = [guid]::NewGuid().ToString()
$wallet = Invoke-RestMethod -Method Post -Uri http://localhost:3000/wallets -ContentType 'application/json' -Body (@{
  playerId = $playerId
  initialBalance = @{ amount = '100.00'; currency = 'BRL' }
} | ConvertTo-Json)
$externalId = [guid]::NewGuid().ToString()
$headers = @{ 'Idempotency-Key' = "provider-a:$externalId"; 'X-Correlation-Id' = 'example-bet' }
$bet = @{
  providerId = 'provider-a'; externalTransactionId = $externalId
  playerId = $playerId; walletId = $wallet.id
  roundId = 'round-1'; gameId = 'game-1'; kind = 'BET'
  money = @{ amount = '80.00'; currency = 'BRL' }
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/wagering/transactions -Headers $headers -ContentType 'application/json' -Body $bet
Invoke-RestMethod -Method Post -Uri http://localhost:3000/wagering/transactions -Headers $headers -ContentType 'application/json' -Body $bet
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/wallets/$($wallet.id)/reconciliation"
```

A primeira aposta retorna saldo `20.00`; a segunda retorna o mesmo resultado com `idempotentReplay: true`. Valores monetários são strings com duas casas, até `999999999999999999.99`. A entrada aceita BRL. UUIDs de player e wallet são normalizados para minúsculas; identificadores de negócio e chaves preservam sua grafia. NUL é recusado nos campos textuais externos.

REFUND exige `referenceExternalTransactionId` de uma BET processada. ROLLBACK aceita BET, WIN ou REFUND processados e inverte seu efeito. Use nova chave/ID externo e o valor integral da referência. Provider, player, wallet, moeda e rodada devem coincidir. Cada referência permite uma reversão por tipo. WIN pode referenciar uma BET. LOSS não movimenta saldo nem gera ledger.

## API

| Método | Caminho |
| --- | --- |
| POST | `/wallets` |
| GET | `/wallets/:walletId` |
| GET | `/wallets/:walletId/ledger?limit=50&cursor=...` |
| POST | `/wagering/transactions` — `Idempotency-Key` obrigatório |
| GET | `/wagering/transactions/:transactionId` |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` |
| POST | `/wallets/:walletId/reconciliation` |
| GET | `/health/live`, `/health/ready`, `/metrics` |

HTTP: 201 para wallet criada; 200 para consulta/operação/replay; 202 para `PENDING_REFERENCE`; 400 para contrato inválido; 404 para recurso inexistente; 409 para conflito; 422 para rejeição financeira persistida; 503 para infraestrutura temporariamente indisponível. Replays preservam resultados terminais, inclusive rejeições e saldo original.

A reconciliação retorna `storedBalance`, `calculatedBalance`, `difference`, `consistent` e `checkedEntries`, sem corrigir divergências. A paginação usa cursor opaco crescente, sem prometer snapshot entre páginas.

## SQS e eventos

| Fila | Responsabilidade |
| --- | --- |
| `wager-transactions.fifo` | Solicitações financeiras |
| `wager-transactions-dlq.fifo` | Contratos inválidos/conflitantes e tentativas esgotadas |
| `wager-events.fifo` | Eventos publicados; não recebe solicitações financeiras |

O [contrato de entrada](docs/CHALLENGE.md#10-processamento-por-sqs) contém `messageId`, `type: "WagerTransactionRequested"`, `occurredAt` e `data`. `data` tem os campos HTTP e `idempotencyKey`. `correlationId` é opcional; quando ausente, usa `messageId`. HTTP e SQS recusam correlationId vazio, com espaços nas extremidades, NUL ou mais de 128 caracteres.

Inbox, operação, ledger e outbox são confirmados juntos; o ack vem após commit. Falhas transitórias têm backoff e redrive após cinco recebimentos. Contratos inválidos e conflitos seguem diretamente à DLQ. Visibilidade de 60 segundos é renovada durante o processamento.

O worker de referências usa oito tentativas persistidas, com intervalos de 5, 10, 20, 40, 80, 160, 300 e 300 segundos. Esgotamento gera rejeição auditável. O publisher tenta novamente com backoff de 1 segundo até 5 minutos, sem descartar eventos pendentes. Consumidores de eventos devem deduplicar por `eventId`.

## Testar

Com dependências instaladas e `.env` configurado:

```sh
docker compose --profile test up -d --wait postgres-test localstack toxiproxy
bun run typecheck
bun run build
bun test test/unit
bun run test:integration
bun run test:distributed
bun run test:broker
```

`TEST_DATABASE_URL` aponta para banco descartável terminado em `_test` (exemplo: porta 5433, banco `jungle_test`). As suítes usam schemas/filas privados. Toxiproxy interrompe somente conexões de teste. Testes distribuídos iniciam três processos NestJS com portas livres; incluem 50 duplicatas HTTP/SQS e disputa de saldo. Testes de crash encerram subprocessos reais.

`test:broker` é **diagnóstico**: mede perdas no restart e recuperação da outbox. A aceitação estrita é separada:

```sh
bun run test:broker:durability
```

Essa aceitação falha se a solicitação ou qualquer evento esperado desaparecer. Não integra a descoberta automática de `*.test.ts`. Os testes de broker usam outro projeto Compose/porta dinâmica e preservam os volumes criados. Resultados e versão testada: [docs/VALIDATION.md](docs/VALIDATION.md).

## Limitações conhecidas

- A aceitação de durabilidade do LocalStack 4.10.0 falha no ambiente validado, inclusive com estratégias de snapshot explícitas. Eventos pendentes no SQL são recuperáveis; eventos já marcados como publicados e solicitações perdidas pelo broker não são reenviados automaticamente.
- A API não implementa autenticação. O guard de extensão está documentado na arquitetura; execute o Compose somente em ambiente local.
- Não há backfill de eventos anteriores à instalação da outbox nem replay administrativo. Ordem de publicação pode variar entre publishers; não há exactly-once.
- A conferência de saldo pelo ledger custa O(n) por wallet. O volume dos testes não representa benchmark de produção. Contadores de métricas são por processo.
