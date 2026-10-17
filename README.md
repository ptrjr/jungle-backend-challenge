# Jungle — núcleo financeiro

Implementação incremental do [desafio oficial](https://github.com/junglegaming/backend-challenge). O enunciado original está preservado em [docs/CHALLENGE.md](docs/CHALLENGE.md).

Etapas 1 a 3: operações financeiras, ledger, idempotência, concorrência por wallet, referências fora de ordem, reconciliação, SQS, inbox/outbox e recuperação de workers. A validação distribuída final da Etapa 4 permanece pendente.

## Executar

Requisitos: Bun **1.3.14**, Docker e Docker Compose v2. A aplicação usa NestJS 11, TypeORM e PostgreSQL 18. Não há autenticação nesta etapa; use apenas em ambiente local.

```sh
bun install --frozen-lockfile
docker compose up -d --wait postgres localstack
docker compose run --rm --no-deps sqs-init
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

O Compose inicia PostgreSQL, LocalStack, inicialização das filas e aplicação. O container aplica migrations antes de iniciar a API. Para múltiplas instâncias, execute migrations separadamente uma vez. Não são necessárias credenciais reais da AWS: `.env.example` usa `test/test` e endpoints locais.

```sh
bun run build
bun run start
bun run migration:revert
```

`build` gera `dist/`; `start` executa o fonte com Bun. Para executar a saída compilada: `bun dist/main.js`. `migration:revert` desfaz somente a última migration. A migration de inbox/outbox remove o histórico de entrega ao ser revertida; use apenas em banco descartável ou após preservar esse histórico. A migration de referências recusa reversão quando há histórico da Etapa 2. A migration inicial remove as tabelas financeiras ao ser revertida.

## Testar

```sh
bun run typecheck
bun run build
bun test test/unit
docker compose --profile test up -d --wait postgres-test localstack toxiproxy
docker compose run --rm --no-deps sqs-init
bun run test:integration
```

`TEST_DATABASE_URL` deve apontar para um banco separado cujo nome termine em `_test`. O valor de `.env.example` usa a porta **5433**. Os testes criam e removem seu próprio schema e não usam mocks do PostgreSQL. O usuário de teste precisa poder criar schemas. Sem a variável, a suíte falha explicitamente.

São cobertos: precisão decimal, transições, todas as operações, saldo insuficiente, identidade e validade de referências, replay com saldo original, duplicação e reversões concorrentes em três pools independentes, disputa `80 + 80` sobre `100`, falhas injetadas, constraints, imutabilidade, contratos HTTP, timeout de lock e paginação. Os novos testes incluem workers concorrentes, backoff/expiração, referências encadeadas, reconciliação concorrente/divergente e migration down/up preservando histórico anterior.

Os testes criam filas e schemas privados. Toxiproxy interrompe conexões reais apenas dos clientes de teste. Dois testes criam e encerram subprocessos Bun em pontos controlados: após commit/antes de ack e após publicação/antes da confirmação SQL. No Windows, a execução precisa permitir criação de processos. `bunfig.toml` desativa os workers automáticos nos testes, inclusive se `.env` habilitar mensageria; os testes do agendador os iniciam explicitamente.

Validação da Etapa 3 em Windows/Bun 1.3.14, PostgreSQL 18.1 e LocalStack 4.10.0 em containers: **38 testes unitários e 52 de integração aprovados**, mantendo os 68 testes anteriores. Typecheck, build e instalação com lockfile congelado passaram. O Compose também foi validado com envio real de solicitações SQS, duplicata, publicação dos eventos, ROLLBACK fora de ordem, reconciliação, métricas e health. O Bun local está em `.local/bun`, pasta ignorada pelo Git; instale a versão indicada no PATH para usar os comandos acima.

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
| GET | `/metrics` | Métricas financeiras e de mensageria em formato Prometheus |
| GET | `/health/live` | Processo vivo, sem consultar dependências |
| GET | `/health/ready` | PostgreSQL e as três filas SQS disponíveis; 503 durante falha |

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

## Mensageria

| Fila | Uso |
| --- | --- |
| `wager-transactions.fifo` | Solicitações de operações |
| `wager-transactions-dlq.fifo` | Contratos inválidos/conflitantes e tentativas esgotadas |
| `wager-events.fifo` | Eventos publicados pela outbox; nenhum consumo financeiro nessa fila |

O contrato de entrada é o da seção 10 de [docs/CHALLENGE.md](docs/CHALLENGE.md): envelope com `messageId`, `type: "WagerTransactionRequested"`, `occurredAt` e `data`. `data` contém o mesmo payload HTTP e `idempotencyKey` obrigatório. `correlationId` é opcional no envelope; seu default é `messageId`. Para HTTP, pode ser enviado no header `X-Correlation-Id`.

Salve um envelope válido em `request.json`. Para enviar, substitua `URL_RETORNADA` pelo resultado de `get-queue-url`, use o walletId como grupo e um novo ID de envio para cada chamada:

```sh
docker compose exec -T localstack awslocal sqs get-queue-url --queue-name wager-transactions.fifo
docker compose cp request.json localstack:/tmp/request.json
docker compose exec -T localstack awslocal sqs send-message --queue-url URL_RETORNADA --message-group-id WALLET_ID --message-deduplication-id ID_DE_ENVIO_UNICO --message-body file:///tmp/request.json
```

O consumidor grava inbox, efeitos financeiros e eventos na mesma transação; confirma a mensagem somente após commit. Rejeições de negócio são persistidas e confirmadas. Contratos malformados, wallet inexistente ou conflitos seguem diretamente à DLQ. Falhas transitórias usam mudança de visibilidade com backoff e redrive após cinco recebimentos; nos testes privados o limite é três para reduzir o tempo de execução. A visibilidade normal é 60 segundos, renovada enquanto a mensagem está em processamento.

`MESSAGING_ENABLED=true` habilita consumidor e publisher. A outbox é gravada mesmo com publicação desabilitada. Eventos pendentes são publicados após commit, com tentativas persistidas e backoff de 1 segundo até 5 minutos, sem descarte por esgotamento. Consumidores externos devem deduplicar por `eventId`; uma falha depois do envio e antes da confirmação SQL pode produzir publicação repetida.

O container aceita SIGTERM, para de buscar trabalho e aguarda operações em andamento; o Compose permite 45 segundos para shutdown. Os testes comprovam espera pelo trabalho em andamento e recuperação após morte forçada. A reinicialização do container da aplicação também foi executada, com readiness saudável ao retornar. Não há autenticação nesta etapa.

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
