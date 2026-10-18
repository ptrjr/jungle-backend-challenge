# Validação final

Ambiente: Windows, Bun 1.3.14, PostgreSQL 18.1, LocalStack 4.10.0 e Toxiproxy 2.12.0. Os testes usam schemas e filas exclusivos; os testes de rede afetam somente os proxies. O teste de restart do broker usa outro projeto Compose. Dados e volumes manuais foram preservados.

Resultado: **96 testes aprovados** (38 unitários, 53 de integração, quatro distribuídos e um de broker), preservando os 90 anteriores. A execução conjunta de unidade/integração/distribuídos passou com 95 testes e 505 verificações; o teste isolado do broker passou separadamente com quatro verificações. Typecheck, build, build Docker e `bun install --frozen-lockfile` aprovados.

Após iniciar a imagem final, `/health/live` e `/health/ready` retornaram 200. A auditoria somente por leitura do ambiente principal confirmou zero wallets divergentes, 11 eventos publicados e zero pendentes. PostgreSQL e aplicação permaneceram ativos; PostgreSQL de testes e Toxiproxy foram encerrados sem remover volumes.

## Auditoria e conformidade

Antes das alterações, a auditoria das seções 4–14 encontrou: regras financeiras e entrega cobertas por 90 testes; concorrência comprovada apenas com pools no mesmo processo; ausência dos cenários de três aplicações e 50 duplicatas distribuídas; restart do broker não verificado; reversibilidade integral em banco vazio ainda não demonstrada. Havia também diferença entre a porta do Compose versionado (5432) e a URL de exemplo (55432).

| Seção | Resultado e evidência |
| --- | --- |
| 4 — stack/migrations | Bun, NestJS, TypeScript strict, TypeORM, PostgreSQL, SQS e Compose. Três migrations down/up em schema vazio; segundo up sem alterações. Downgrade com histórico tem pré-condições. |
| 5 — restrições | Decimal strings/decimal.js/numeric; locks por wallet; inbox e idempotência no PostgreSQL; ledger imutável; outbox invisível antes do commit. |
| 6 — domínio/schema | Factories/rehydrate, transições terminais, unicidades, escala e não-negatividade no banco; testes de violação direta das constraints. `FAILED` permanece reservado, sem emissão artificial após rollback. |
| 7 — operações/referências | BET/WIN/LOSS/REFUND/ROLLBACK, identidade completa, reversão integral e única por tipo, rejeição específica de reversão sem saldo; agenda e expiração persistidas. |
| 8 — concorrência | Três processos NestJS; barreira e locks observados no PostgreSQL; disputa de saldo e wallets distintas. |
| 9 — HTTP | Endpoints, contratos, rejeições, conflitos, replay original, reconciliação consistente por snapshot e health cobertos. Autenticação omitida conforme seção 2, com guard de extensão. |
| 10 — SQS/inbox | 50 entregas reais, um recibo e um débito; ack após commit, redelivery, retry/DLQ e shutdown. |
| 11 — outbox | Gravação atômica, publishers concorrentes, backoff persistido; morte após envio repete o mesmo eventId. Durabilidade do broker local tem limitação descrita abaixo. |
| 12 — observabilidade | Logs JSON, correlação, métricas de status/duplicatas/retries/DLQ/locks/lag/latência; live/ready separados, com dependências indisponíveis. |
| 13 — testes | Suítes unitárias, PostgreSQL/SQS reais, rede interrompida, subprocessos mortos e três aplicações independentes. Comandos abaixo. |
| 14 — eliminatórios | Nenhuma violação observada nos cenários executados: sem dinheiro em number, saldo negativo por race, efeito duplicado, idempotência em memória, dependência de instância única, publicação pré-commit ou ledger ausente. Banco e broker reais. |

## Resultados dos cenários

| Cenário | Resultado verificado |
| --- | --- |
| 100.00, duas BET de 80.00 em processos diferentes | Uma PROCESSED, outra REJECTED/INSUFFICIENT_FUNDS, saldo 20.00, um débito. |
| 50 requisições HTTP iguais em três processos | Um ID de transação, uma resposta original e 49 replays, um débito e dois eventos. Após crédito posterior, replay conserva saldo original de 20.00. |
| Wallets diferentes | Duas aplicações concluem enquanto a wallet da terceira permanece bloqueada. |
| 50 cópias SQS após restart das aplicações | Três consumers registram duplicatas; soma de 49 duplicatas, uma inbox, um débito, saldo 20.00 e DLQ vazia. Grupos FIFO e deduplication IDs distintos. |
| Backlog da outbox após restart | Eventos pendentes drenados; pelo menos dois processos publicam; cada linha confirma uma tentativa na execução normal, nenhum evento pendente ao final. |
| Processo morto após commit/antes do ack | Redelivery reutiliza inbox; saldo e ledger mantêm um efeito. |
| Publisher morto após envio/antes da confirmação SQL | Nova publicação com o mesmo eventId; confirmação posterior no PostgreSQL. |
| PostgreSQL indisponível via TCP | Sem ack nem efeito confirmado; retomada confirma uma vez. |
| SQS indisponível via TCP | Backoff persistido; publisher com nova conexão retoma eventos. |
| Retry/DLQ | Contrato inválido segue à DLQ; falha transitória esgota redrive privado de três recebimentos (configuração principal: cinco). |
| Referências fora de ordem | Resolução e expiração persistidas, eventos correlacionados sem repetir efeito. |
| Consistência final | Saldo igual à soma do ledger em todos os schemas de cenários financeiros. |

Os testes existentes de crash usam SIGKILL real em subprocessos. Shutdown em andamento usa o hook real com barreira controlada; não representa um SIGTERM no exato intervalo entre commit e ack. O teste distribuído encerra as aplicações com SIGTERM entre as fases.

## Limitações e riscos

- No restart isolado, o LocalStack perdeu filas e mensagens mesmo com `PERSISTENCE=1` e volume preservado. Duas mensagens de eventos já publicados e uma solicitação não consumida não sobreviveram. A outbox recuperou dois eventos ainda pendentes; não republica automaticamente o histórico marcado como publicado. Durabilidade efetiva do broker e recuperação operacional são necessárias antes de uso real.
- Consumidores de eventos devem deduplicar por eventId; ordem de publicação pode variar. Não há promessa de exactly-once.
- Downgrade da Etapa 2 recusa histórico incompatível. O comando de migrations também recusa apagar histórico financeiro/inbox/outbox; chamadas diretas ao ORM por administradores continuam capazes de executar os `down` destrutivos originais. O rollback integral é demonstrado em banco vazio, sem converter/apagar histórico real.
- A conferência do ledger continua O(n) por wallet. Não causou falha nos cenários executados; não foi feita caracterização com histórico longo nem benchmark de produção.
- Autenticação, backfill de eventos anteriores à Etapa 3, replay administrativo e dashboards não foram adicionados. As métricas de contadores são por processo. Não houve merge nem push.

## Reprodução

Com Bun 1.3.14 no PATH e Docker Compose v2:

```sh
cp .env.example .env
# PowerShell: Copy-Item .env.example .env
bun install --frozen-lockfile
docker compose up -d --wait postgres localstack
docker compose run --rm --no-deps sqs-init
bun run migration:run
docker compose up --build -d app
docker compose --profile test up -d --wait postgres-test toxiproxy
bun run typecheck
bun run build
bun test test/unit
bun run test:integration
bun run test:distributed
bun run test:broker
```

Se 5432 estiver ocupada, ajuste `POSTGRES_PORT` e a porta de `DATABASE_URL` no `.env` para 55432 antes de iniciar. O ambiente de validação manteve 55432 localmente. `TEST_DATABASE_URL` usa o banco separado `jungle_test`, porta 5433. Para um único comando de testes após a infraestrutura:

```sh
bun test --timeout 60000 test/unit test/integration test/distributed test/broker
```

O teste do broker declara timeout próprio de 120 segundos. Os subprocessos exigem permissão de execução e os testes do broker exigem acesso ao Docker. As portas HTTP dos três processos e a porta do broker isolado são dinâmicas. Para encerrar apenas a infraestrutura de testes compartilhada: `docker compose --profile test stop postgres-test toxiproxy`. Não execute `down -v` sobre o ambiente manual.
