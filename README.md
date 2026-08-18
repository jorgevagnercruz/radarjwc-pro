# Radar JWC PRO

Código-fonte reconstruído a partir da versão **v0.9.1 · REAL DATA** atualmente publicada na Vercel.

## Estrutura

- `index.html` — interface atual do Radar JWC PRO.
- `api/scanner.js` — busca o **Trend Resource** do football-data.org por data, usando `window=10` e `consider_side`.
- `api/live.js` — consulta os jogos em andamento na Sportmonks e calcula o índice de pressão JWC.
- `db/schema.sql` — estrutura mínima para persistir fixtures, métricas pré-jogo e snapshots ao vivo no Neon.
- `.env.example` — nomes das variáveis de ambiente, sem credenciais.

## Variáveis de ambiente

Configure na Vercel:

- `FOOTBALL_DATA_TOKEN`
- `SPORTMONKS_TOKEN`
- `DATABASE_URL` (opcional; necessário para persistência no Neon)

**Não coloque tokens reais no GitHub.**

## Como publicar no GitHub

Na pasta do projeto:

```bash
git init
git branch -M main
git add .
git commit -m "feat: Radar JWC PRO v0.9.1"
git remote add origin https://github.com/jorgevagnercruz/radarjwc-pro.git
git push -u origin main
```

## Vercel

Depois de subir ao GitHub:

1. Abra o projeto `radar-jwc-pro` na Vercel.
2. Conecte o repositório `jorgevagnercruz/radarjwc-pro`.
3. Configure as variáveis de ambiente.
4. Faça o deploy da branch `main`.

## Nota metodológica

Os percentuais pré-jogo são **frequências históricas observadas**, não probabilidades calibradas.  
O `JWC Score` e o `Pressure Score` são índices proprietários/heurísticos em processo de validação.
