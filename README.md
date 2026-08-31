# Radar JWC PRO

Versão 2.5.0 com sinais de gol ao vivo, alerta por Telegram, QR Code Pix por plano, página pública de apresentação, resultados verificados, scanner pré-jogo, radar multifonte, controle de usuários e comprovantes de pagamento.

## Página pública

- Visitantes sem sessão são direcionados de `/` para `/apresentacao.html`.
- Plano mensal: R$ 15 por 30 dias. Plano anual: R$ 100 por 365 dias.
- A chave Pix pública possui botão de cópia e o pagamento continua sujeito à conferência do administrador.
- Os botões de plano abrem o cadastro com a opção escolhida.
- O plano e o valor são registrados no comprovante; a intenção inicial também fica no log de auditoria.
- A seção pública de resultados usa `/api/performance?public=1` e não exige sessão.
- O resumo não expõe equipes, usuários ou palpites individuais.
- Só entram análises salvas antes do início da partida. A taxa aparece após 30 sinais conferidos.

## Proteção contra limite da API

- O Scanner reaproveita por 30 minutos a análise completa armazenada no Neon.
- Chamadas simultâneas para a mesma data são serializadas por uma trava transacional.
- Todas as chamadas ao football-data.org entram em uma fila global e ficam separadas por pelo menos sete segundos, inclusive quando usuários pesquisam datas diferentes.
- Quando o football-data.org responde com limite temporário, o sistema respeita o período de espera e exibe a última análise salva.
- Dados antigos já existentes no Neon servem como fallback para +1.5, Gol HT, +2.5 e ambas marcam.
- A conferência de placares evita novas consultas durante dez minutos e não repete chamadas de partidas já concluídas.

## Radar ao vivo multifonte

- Sportmonks continua sendo consultada nas competições incluídas na assinatura.
- API-Football amplia a descoberta de partidas ao vivo e fornece estatísticas detalhadas quando disponível.
- O Neon compartilha o resultado por quatro minutos entre todos os usuários, alinhado ao agendamento de cinco minutos e evitando uma consulta por usuário.
- Estatísticas detalhadas são renovadas a cada 150 segundos, com no máximo seis partidas por ciclo.
- O painel separa jogos encontrados, jogos com estatísticas, partidas dentro do padrão 50+ e pressão forte 80+.
- Se uma fonte oscilar, o sistema exibe por até dez minutos a leitura recente salva no Neon.
- As partidas duplicadas entre fornecedores são unificadas, com preferência pelo registro de melhor cobertura estatística.

## Sinais de gol ao vivo

- O motor compara duas leituras reais da mesma partida; números finais nunca são usados para simular um sinal anterior.
- Há regras separadas para 0 a 0 no primeiro tempo, 0 a 0 no segundo tempo e novo ciclo depois do primeiro gol.
- O sinal combina pressão acumulada, finalizações recentes, chutes no gol, ações dentro da área, ataques perigosos, escanteios e xG quando disponível.
- Cada sinal é único por partida e placar, evitando mensagens repetidas.
- O Neon registra o instante do sinal e confere automaticamente se ocorreu gol em até 5, 10 ou 15 minutos.
- O Telegram informa apenas possibilidade de gol na partida; o motor não afirma qual equipe marcará.
- A rota `/api/live` aceita sessão ativa ou `Authorization: Bearer CRON_SECRET` para execução agendada.

### Agendamento

- No plano Vercel Pro, use Cron nativo a cada minuto chamando `/api/live`.
- No plano Hobby, o workflow `.github/workflows/monitor-live-goals.yml` oferece atualização a cada cinco minutos.
- Configure o mesmo valor em `CRON_SECRET` na Vercel e `RADAR_CRON_SECRET` nos Secrets do GitHub.
- O workflow encerra sem erro enquanto o segredo não estiver configurado.

## Filtros de palpites

- Ao selecionar Faixa A, +1.5, Gol HT ou Bingo, a lista mostra somente as partidas que atingiram o corte escolhido.
- O título acima da lista informa qual palpite está ativo e quantas partidas foram encontradas.
- Cada cartão destaca o palpite selecionado, seu percentual histórico ou sua pontuação correspondente.
- A ordenação muda automaticamente para o critério escolhido, sem impedir ajustes manuais posteriores.

## Índice JWC

- Escala de 0 a 100 baseada na convergência das frequências históricas analisadas.
- Faixa A, de 65 a 100: cenário mais favorável.
- Faixa B+, de 55 a 64: cenário moderado.
- Faixa C, abaixo de 55: cautela recomendada.
- O índice organiza os jogos; não representa probabilidade calibrada nem garantia de acerto.

## Controle de acesso

- Solicitação pública de cadastro.
- Aprovação ou recusa pelo administrador.
- Acesso por 30 dias, 365 dias ou data personalizada.
- Bloqueio automático após o vencimento.
- Suspensão, reativação e encerramento remoto de sessões.
- Senhas derivadas com scrypt e salt individual.
- Sessões armazenadas apenas como hash no Neon.
- Cookie HttpOnly, Secure e SameSite=Lax em produção.
- Bloqueio temporário após cinco tentativas incorretas.
- Registro de auditoria das ações administrativas.

## Pagamentos e comprovantes

- O comprovante pode ser incluído na solicitação inicial ou enviado posteriormente em `Minha conta`.
- Usuários com acesso vencido conseguem entrar apenas na conta para solicitar renovação; as APIs do Radar continuam bloqueadas.
- O administrador visualiza o arquivo de forma privada e marca o pagamento como confirmado ou rejeitado.
- O usuário informa somente o arquivo; cada lançamento guarda situação, datas e histórico da conferência.
- O usuário escolhe o plano mensal ou anual antes de enviar o arquivo; o valor é definido pelo servidor.
- Arquivos permitidos: PDF, JPG, PNG e WebP, limitados a 2 MB e validados pela assinatura real do arquivo.
- Os arquivos ficam no Neon e nunca são expostos por URL pública. A leitura exige uma sessão administrativa válida.

## Fluxo

1. A pessoa abre `/apresentacao.html`, escolhe um plano e solicita cadastro.
2. A solicitação aparece em `/admin.html`.
3. O administrador abre o comprovante, confirma ou rejeita o pagamento, define o período e aprova.
4. O usuário entra com e-mail e senha.
5. As APIs do scanner, live e resultados validam a sessão e o vencimento.

## Migrações

Execute, nesta ordem:

1. `db/migrations/20260819_auth_users.sql`
2. `db/migrations/20260819_payment_receipts.sql`
3. `db/migrations/20260819_simplify_payment_receipts.sql`

## Variáveis

`FOOTBALL_DATA_TOKEN`, `SPORTMONKS_TOKEN`, `API_FOOTBALL_KEY`, `DATABASE_URL`, `CRON_SECRET`, `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`. Nunca publique valores reais no GitHub.

`FOOTBALL_DATA_TOKEN` pertence ao football-data.org e não deve receber a chave da API-Football. A nova chave deve ser cadastrada separadamente como `API_FOOTBALL_KEY`.

Crie o bot no Telegram, inicie uma conversa com ele e salve o token e o identificador do chat somente nas variáveis da Vercel. O token nunca deve aparecer no código ou nos logs.

## Cortes avaliados

- +1.5 FT: 80%
- Gol HT: 60%
- +2.5 FT: 65%
- Ambas marcam: 65%

Frequências históricas e o JWC Score não são probabilidades calibradas.
