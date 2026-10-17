# Decisões das Etapas 1 e 2

## Organização e persistência

`domain/` contém classes sem dependência de NestJS/ORM, com construtores privados, factories e transições explícitas. `application/financial-service.ts` coordena uma transação SQL por comando. Controllers validam o contrato e traduzem resultados para HTTP. Não há barramento interno, factories de repositórios ou camadas genéricas.

TypeORM foi escolhido pela familiaridade do candidato. `EntitySchema` mapeia registros de persistência separados das classes de domínio; o serviço chama `rehydrate` ao reconstruir o estado. Isso também evita depender da emissão de metadados de propriedades pelo transpiler do Bun. A injeção de dependências usa `@Inject` explícito e os DTOs informam seu tipo ao `ValidationPipe`.

`Money` usa `decimal.js`, precisão de 40 dígitos, operações imutáveis e strings de escala 2. Valores negativos existem no domínio para subtrações/diferenças; os contratos de entrada os recusam. Não há arredondamento de entradas inválidas. Limite: `999999999999999999.99`. O banco usa um domain sobre `numeric` com validação de escala/faixa; `numeric(20,2)` arredondaria entradas com casas excedentes antes da constraint. O driver PostgreSQL mantém decimais como strings. A API restringe moeda a BRL; o modelo preserva a moeda e impede operações entre moedas diferentes.

## Concorrência, atomicidade e histórico

O processamento bloqueia a linha da wallet com `SELECT FOR UPDATE` em `READ COMMITTED`. A leitura do saldo, decisão, atualização, transação e ledger ficam na mesma transação SQL. O lock é por wallet e funciona entre processos; wallets diferentes não compartilham lock. Locks são liberados no commit/rollback. Timeouts de lock/statement produzem falha transitória, sem retry automático HTTP.

A inserção da operação vem **depois** do lock da wallet para evitar upgrades concorrentes dos locks da FK. A unicidade no banco continua decidindo conflitos entre wallets/chaves. `ON CONFLICT DO NOTHING` permite consultar a operação vencedora em um novo statement sem manter uma transação SQL abortada por violação de unicidade.

O schema impõe unicidade player/moeda, chave global de idempotência, provider/ID externo e transação no ledger; valores não negativos; aritmética do lançamento; FKs; identidade/versão da wallet; bloqueio de UPDATE/DELETE/TRUNCATE do ledger e de alterações em transações terminais. Constraint triggers diferidos verificam no commit o vínculo entre transação processada e ledger e a igualdade `wallet.balance = soma do ledger`.

A segunda migration acrescenta referências e valida no banco a identidade completa, tipo, estado processado e valor integral da referência. Um índice único parcial em `(reference_transaction_id, kind)` para reversões processadas impede duplicação mesmo em SQL concorrente. Reversões rejeitadas permanecem auditáveis sem ocupar essa unicidade. O downgrade restaura as constraints/funções anteriores, mas recusa execução quando há histórico da Etapa 2: apagar esse histórico para satisfazer o schema antigo violaria a auditoria. A migration inicial permanece inalterada.

Essa verificação adicional soma o histórico da wallet no commit: custo O(n) por wallet, aceitável para o volume do desafio, mas seria preciso medir antes de adotar em produção. O serviço ainda usa lock explícito: constraints não substituem o controle de concorrência. O usuário de produção não deve ter privilégios para desabilitar triggers ou alterar schema; o Compose usa credenciais locais de desenvolvimento.

Abertura positiva gera `OPENING` interno e crédito, mantendo versão 1. Abertura zero não gera transação/ledger. Apenas alterações efetivas de saldo incrementam a versão; `LOSS` e rejeições não incrementam. `BET/WIN` exigem valor positivo; `LOSS` aceita valor não negativo apenas como informação, sem efeito financeiro.

## Idempotência e estados

O header é obrigatório, global e não é derivado silenciosamente. SHA-256 recebe UTF-8 de JSON canônico dos campos validados de negócio: provider, ID externo, player, wallet, round, game, kind e money. Chaves de objetos são ordenadas recursivamente; strings e arrays preservam conteúdo/ordem. Header e transporte ficam fora do hash. Campos extras são recusados pela API.

Mesmo header + mesmo payload retorna ID, status, falha e **saldo originais** persistidos, mudando apenas `idempotentReplay` para true. Mesmo header com outro payload retorna `IDEMPOTENCY_CONFLICT` (409). Mesmo provider/ID externo com outra chave retorna `EXTERNAL_TRANSACTION_CONFLICT` (409), mesmo que o payload seja igual. Operações rejeitadas também são persistidas e reproduzidas; um depósito posterior não transforma a mesma aposta rejeitada em débito.

`PENDING → PROCESSED | REJECTED | PENDING_REFERENCE` ocorre dentro da transação SQL, sem `PENDING` confirmado isoladamente. Uma pendência pode continuar em `PENDING_REFERENCE` ou terminar em `PROCESSED/REJECTED`. Estados terminais não admitem nova transição. `FAILED` está reservado para falhas permanentes auditáveis da etapa de mensageria; não é emitido pelo fluxo atual. Falhas transitórias fazem rollback e permitem reenvio com a mesma chave.

O hash inclui `referenceExternalTransactionId` quando informado e mantém o algoritmo anterior para operações sem referência. Replay de pendência reflete o estado atual e mantém o saldo da aceitação enquanto aguarda; após aplicação ou rejeição, conserva o resultado terminal. Reenviar HTTP não consome tentativas nem antecipa a agenda.

| Código de rejeição (422) | Motivo |
| --- | --- |
| `INSUFFICIENT_FUNDS` | Saldo insuficiente para BET |
| `PLAYER_MISMATCH` | Player não é o dono da wallet |
| `CURRENCY_MISMATCH` | Moeda da operação difere da wallet |
| `BALANCE_LIMIT_EXCEEDED` | Crédito excederia o limite monetário |
| `INVALID_REFERENCE` | Autorreferência ou identidade externa incompatível |
| `REFERENCE_*_MISMATCH` | Provider, player, wallet, moeda, rodada, tipo ou valor incompatível com a referência |
| `REFERENCE_NOT_PROCESSED` | Referência terminal não processada, ou ainda pendente ao esgotar tentativas |
| `REFERENCE_ALREADY_REVERSED` | Já houve reversão processada do mesmo tipo |
| `REFERENCE_NOT_FOUND` | Referência ausente ao esgotar as tentativas |
| `REVERSAL_INSUFFICIENT_FUNDS` | Reversão produziria saldo negativo |

Moeda diferente chega ao caso de uso como rejeição auditável; o contrato HTTP desta etapa recusa moedas além de BRL com 400. Payload malformado ou wallet inexistente não é uma operação aceita e não cria transação.

## Referências e worker

A resolução consulta exclusivamente `(providerId, referenceExternalTransactionId)`. Um ID existente apenas em outro provider é uma referência ausente nesse escopo; aguarda e eventualmente expira. Não consultamos outro provider para inferir rejeição. Referências resolvidas precisam coincidir com player, wallet, moeda e rodada. REFUND aceita BET; ROLLBACK aceita BET/WIN/REFUND; WIN referenciado aceita BET. Igualdade de valor é exigida somente nas reversões. REFUND e ROLLBACK da mesma BET podem ocorrer uma vez cada, seguindo a regra por tipo da seção 7 do enunciado.

HTTP e worker reutilizam `applyTransaction` com o mesmo `EntityManager`: saldo, ledger, status e agenda são confirmados juntos. O worker primeiro seleciona uma wallet com pendência vencida usando `FOR UPDATE SKIP LOCKED`, depois bloqueia sua transação. Essa ordem também é usada no HTTP, evitando ciclos de locks. A próxima tentativa é gravada antes de liberar o lock; outra instância encontra o novo estado. O controle local de execução do timer apenas evita trabalho sobreposto na própria instância.

O agendador roda a cada segundo, até 25 operações por rodada. São oito reprocessamentos por pendência, com backoff exponencial de 5 segundos limitado a 300 segundos: cerca de 15 minutos de espera com serviço disponível. O limite curto mantém a recuperação verificável no desafio; em produção dependeria do contrato de atraso dos provedores. Indisponibilidade prolonga esse prazo, pois o limite é por tentativas, não TTL. Falha SQL faz rollback também do contador; após reinício outra instância usa a agenda persistida. No shutdown, o timer é cancelado e o lote em andamento termina antes do encerramento do DataSource.

Os testes de expiração fornecem o instante ao reprocessamento para avançar a agenda sem esperar minutos; estado, locks e constraints continuam no PostgreSQL real. Um teste adicional usa o timer real. Os cenários concorrentes usam três pools independentes e chamadas paralelas, sem mocks de banco.

## Reconciliação

`POST /wallets/:walletId/reconciliation` usa uma única consulta com agregação do ledger. O snapshot do statement PostgreSQL inclui saldo e lançamentos confirmados no mesmo instante, mesmo com movimentações concorrentes. Soma e diferença são calculadas como `numeric` no PostgreSQL e serializadas como strings, inclusive divergências fora do limite operacional de Money. Apenas a contagem de lançamentos usa `number`.

Divergências não provocam correção. Geram log estruturado com walletId e incrementam um contador por processo exposto em `/metrics`; esse contador reinicia com a aplicação, como contadores usuais de métricas. A observabilidade completa continua pendente. O teste de corrupção desabilita temporariamente apenas o trigger de consistência de wallets no schema isolado de teste, e restaura o saldo manualmente depois da verificação; a aplicação não possui esse caminho.

## Limites e próximos passos

Não há autenticação. `ProviderAuthGuard` é o ponto de extensão explícito: uma implementação futura validaria tokens OIDC de IdP externo e autorizaria o provider da requisição; não haverá tabela própria de senhas. A API local confia no provider informado.

Etapa 3: inbox/outbox, eventos tipados, SQS, publishers, retry/backoff de mensagens, DLQ e shutdown de mensagens. **Nenhum evento é publicado nesta etapa e ainda não há registro de eventos para publicação futura**, inclusive nas rejeições por expiração. A integração deverá gravar a outbox dentro de `applyTransaction`, usando o mesmo `EntityManager`, antes do commit. Não há callback em memória após commit como garantia de entrega.

Etapa 4: health de processo/dependências, correlação e métricas completas, testes reais em três processos e recuperação após falhas de workers. A paginação atual usa sequência global crescente codificada com o walletId em base64url; é estável para operações da mesma wallet porque são serializadas no banco. Não é um snapshot: novos lançamentos podem aparecer nas páginas seguintes.

Na validação em Windows, matchers assíncronos `expect(promise).rejects.toThrow` provocaram timeouts/crashes no Bun 1.4.3 e 1.3.14. Os testes de integração aguardam a operação em `try/catch` e verificam a exceção recebida. A suíte passou com esse formato no Bun 1.3.14, versão fixada para reprodução.
