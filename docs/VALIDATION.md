# Evidências de validação

Código testado: **`bc05118`**, incluindo `fc6bb33` (identidade/validação) e `71bf8a2` (worker/concorrência). Alterações posteriores deste relatório são documentais. Execução em 18/10/2026, Windows, Bun 1.3.14, PostgreSQL 18.1, LocalStack 4.10.0 e Toxiproxy 2.12.0.

## Resultado executado

| Verificação | Resultado |
| --- | --- |
| Instalação com lockfile congelado | Aprovada, sem alteração de dependências |
| Typecheck e build | Aprovados |
| Build Docker | Aprovado |
| Unidade, integração e distribuídos | **103 aprovados**, zero falhas, 596 verificações |
| Diagnóstico de restart do broker | **2 aprovados**, oito verificações; aprovação mede diagnóstico/recuperação, não durabilidade |
| Aceitação estrita de durabilidade | **1 falha**, zero aprovações: solicitação e dois eventos perdidos |

Total: **105 testes aprovados e uma aceitação separada reprovada**. A suíte contém 39 unitários, 60 de integração, quatro distribuídos e dois diagnósticos de broker. As assertions originais de distribuição uniforme de duplicatas foram substituídas por participação comprovada, preservando unicidade e saldo. O antigo teste de broker foi separado em diagnósticos e aceitação estrita; perda não é contabilizada como sucesso de durabilidade.

Os testes usam PostgreSQL e SQS reais, schemas/filas exclusivos e outro projeto Compose para restart do broker. Toxiproxy interrompe somente clientes de teste. Volumes de desenvolvimento não são removidos ou reiniciados pelos experimentos.

A imagem corrigida foi iniciada após o build: liveness/readiness retornaram 200, com PostgreSQL e SQS disponíveis. Auditoria somente por leitura do banco de desenvolvimento encontrou zero wallets divergentes, 11 eventos publicados e zero pendentes.

## Achados da auditoria

| Achado | Estado | Evidência |
| --- | --- | --- |
| A1 — UUIDs | Corrigido | HTTP e SQS: abertura com player maiúsculo, BET com outra grafia, WIN com wallet maiúscula, REFUND, replay e eventos persistidos. Cursor/rotas/reconciliação aceitam grafias equivalentes. Hashes históricos não são reescritos; rejeição antiga permanece rejeitada. |
| A2 — NUL | Corrigido | Campos de negócio retornam HTTP 400; mensagem malformada segue à DLQ, sem inbox/operação/efeito adicional. Payload válido posterior funciona. Headers, rotas e envelope também têm verificação. |
| A3 — broker | Diagnóstico corrigido; durabilidade pendente | Dois modos de snapshot perdem dados; aceitação separada falha explicitamente. Outbox recupera apenas os eventos pendentes. |
| A4 — worker | Corrigido | Logs terminais correlacionados e latência após commit. Falha injetada em constraint diferida impede log de sucesso/amostra confirmada e desfaz efeitos/tentativa. |
| A5 — documentação | Corrigido por revisão | README orientado à execução do serviço, exemplos PowerShell, arquitetura e limitações; este relatório identifica a versão testada. |
| A6 — correlationId | Corrigido | HTTP/SQS compartilham tamanho, bordas e NUL; testes de valores válidos/inválidos e fallback real para messageId. |
| A7 — distribuição | Corrigido | Três PIDs/portas, três application_names aguardando locks antes da liberação e amostras de processamento em todos os processos. A soma continua em 49 duplicatas, sem exigir duplicatas em cada consumer. |

## Invariantes e cenários reais

| Cenário | Resultado |
| --- | --- |
| Duas BET de 80.00 sobre 100.00 em processos diferentes | Uma PROCESSED, outra REJECTED/INSUFFICIENT_FUNDS; saldo 20.00, um débito |
| 50 duplicatas HTTP em três aplicações | Um ID, um efeito, uma resposta original e 49 replays; saldo original preservado após crédito posterior |
| Wallets distintas | Outras duas concluem enquanto a primeira permanece bloqueada |
| 50 cópias SQS após reinício das aplicações | Uma inbox, um débito, saldo 20.00 e DLQ vazia; grupos FIFO/deduplication IDs distintos |
| Publishers concorrentes | Pelo menos dois processos publicam backlog; cada evento confirma uma tentativa normal, sem pendências ao final |
| Morte após commit/antes do ack | SIGKILL real; redelivery sem segundo efeito |
| Morte após envio/antes da confirmação SQL | SIGKILL real; repetição do mesmo eventId e confirmação posterior |
| PostgreSQL indisponível | Sem ack/efeito confirmado; retomada confirma uma vez |
| SQS indisponível | Backoff persistido; nova conexão/publisher recupera pendências |
| Retry/DLQ | Contrato inválido vai diretamente à DLQ; falha transitória esgota redrive privado de três recebimentos (principal: cinco) |
| Referências fora de ordem | Resolução e expiração persistidas; eventos e logs correlacionados |
| Atomicidade e constraints | Falha na outbox desfaz inbox/transação/saldo/ledger; evento não confirmado invisível a outro publisher; mutações do histórico recusadas |
| Reconciliação | Snapshot consistente durante escrita; divergência simulada é sinalizada sem correção automática |
| Migrations | Down/up em schema vazio; segundo up sem alterações; downgrade documentado recusa apagar histórico |
| Invariante final | Nenhum saldo negativo ou efeito duplicado observado; saldo igual à soma do ledger nos schemas financeiros |

Shutdown em andamento é testado pelo hook real com barreira controlada. O teste distribuído envia SIGTERM entre fases. Isso não equivale a testar SIGTERM exatamente entre commit e ack; essa janela é coberta por SIGKILL/redelivery.

## Investigação da durabilidade

Imagem inspecionada: `localstack/localstack:4.10.0`, digest `sha256:a65ee2a9d45a7a34a1f1faae515d2e577ce11210312c077700ccc82daefec238`.

Foram executados três experimentos isolados: diagnóstico com estratégias padrão, diagnóstico com `SNAPSHOT_SAVE_STRATEGY=ON_SHUTDOWN`/`SNAPSHOT_LOAD_STRATEGY=ON_STARTUP` e aceitação estrita com estratégias explícitas. Todos usam `PERSISTENCE=1`, volume próprio, porta dinâmica e `docker compose restart --timeout 45 broker`, seguido de espera por disponibilidade.

Nos três casos, o runtime confirmou persistência habilitada e um arquivo marcador no volume sobreviveu ao restart. Entretanto, uma solicitação não consumida e os dois eventIds previamente publicados não sobreviveram. A comparação usa os eventIds recebidos, não apenas a contagem aproximada da fila. O publisher com nova conexão recuperou exatamente dois eventos pendentes, sem reenviar o histórico publicado. Saldo/ledger continuaram consistentes.

A imagem inspecionada não contém o módulo `localstack.pro`. A [documentação oficial atual de persistência](https://docs.localstack.cloud/aws/developer-tools/snapshots/persistence/) descreve snapshots, estratégias de save/load e configuração com imagem Pro. Essa documentação não prova, por si só, a causa interna da perda na versão 4.10.0. As evidências descartam perda do volume e insuficiência apenas dos parâmetros explícitos testados; não demonstram se a causa exata é ausência de suporte nessa edição ou um defeito da implementação. Não foram testadas edição licenciada, outras imagens/versões ou outros emuladores.

**Durabilidade do broker não aprovada.** A outbox protege a publicação ainda pendente no SQL; não substitui retenção de mensagens já aceitas pelo broker nem recria solicitações perdidas antes do commit. Não há replay automático do histórico publicado para contornar o teste.

## Reprodução

Arquivos alterados nesta revisão:

- `src/application/financial-service.ts`, `src/application/reconciliation.service.ts`.
- `src/http/dto.ts`, `src/http/financial.controller.ts`, `src/http/input-validation.ts`.
- `src/messaging/inbox.processor.ts`, `src/messaging/request-message.ts`.
- `test/integration/input-regressions.test.ts`, `test/integration/reference-observability.test.ts`.
- `test/unit/messaging.test.ts`, `test/distributed/application.test.ts`.
- `test/helpers/broker-restart.ts`, `test/broker/persistence.test.ts`, `test/broker/durability.acceptance.ts`.
- `compose.broker-test.yaml`, `package.json`, `README.md`, `ARCHITECTURE.md`, `docs/VALIDATION.md`.

Com Bun 1.3.14 no PATH, Docker Compose v2 e `.env` criado conforme o README:

```sh
bun install --frozen-lockfile
docker compose --profile test up -d --wait postgres-test localstack toxiproxy
bun run typecheck
bun run build
bun test --timeout 60000 test/unit test/integration test/distributed
bun run test:broker
bun run test:broker:durability
```

O último comando executa a aceitação separada e retorna erro na imagem validada. Seu arquivo termina em `.acceptance.ts`, fora da descoberta automática de `*.test.ts`. O diagnóstico termina em `.test.ts`. Não omita a falha de aceitação ao reportar resultados.

`TEST_DATABASE_URL` precisa apontar para um banco terminado em `_test`; o exemplo usa `postgresql://jungle:jungle@localhost:5433/jungle_test`. Bun carrega `.env`. Sem arquivo, no PowerShell: `$env:TEST_DATABASE_URL='postgresql://jungle:jungle@localhost:5433/jungle_test'`. Os subprocessos exigem permissão de execução; testes do broker exigem acesso ao Docker. Portas HTTP e broker isolado são atribuídas pelo sistema. Para encerrar infraestrutura compartilhada de testes: `docker compose --profile test stop postgres-test toxiproxy`. Não use `down -v` no ambiente de desenvolvimento.

## Conformidade e riscos restantes

As seções 4–10 e 12 do enunciado têm implementação e testes dos mecanismos exigidos: stack, domínio, schema, dinheiro exato, operações, concorrência, idempotência, HTTP, inbox, logs/métricas/health. A seção 11 tem atomicidade, recuperação e publicação at-least-once validadas; a persistência do broker local após restart continua reprovada na verificação adicional. A seção 13 inclui testes reais, três processos e 50 duplicatas, com a falha de durabilidade explicitada.

Nenhuma falha eliminatória financeira foi observada nos cenários executados. A perda de mensagens confirmadas pelo broker permanece um risco de entrega relevante e impede afirmar durabilidade ponta a ponta. Recomenda-se apresentar o núcleo financeiro com essa ressalva explícita; se sobrevivência ao restart do broker for condição de aceite, a entrega ainda tem essa pendência.

Outros limites: custo O(n) do ledger não caracterizado com histórico longo; ordenação de publicação pode variar; consumidores externos devem deduplicar eventId; autenticação omitida conforme permitido; não há backfill/replay administrativo. Contadores são por processo. As chamadas diretas ao ORM por administradores podem contornar a proteção do comando de downgrade, conforme documentado na arquitetura.
