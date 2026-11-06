# İşlerim — kişisel iş hatırlatıcısı

Telefonda ana ekrana eklenen, bilgisayarda tarayıcıdan açılan, ücretsiz çalışan kişisel hatırlatıcı.

- Tek satırda iş ekleme: “yarın saat 10’da bankayı ara, önemli” → saat ve önem otomatik
- Önem derecesine göre gruplanmış liste, tamamlananlar için ayrı arşiv
- Saatinde telefona bildirim (Web Push), tekrarlayan işler
- Siri kestirmesiyle kilit ekranından sesli ekleme
- Analiz sayfası ve Excel’e (CSV) aktarma

Cloudflare Workers + Durable Objects (SQLite) üzerinde çalışır; ücretsiz plan yeterlidir.

## Geliştirme

```
npm install
npm run dev     # http://localhost:8787
npm test
```

## Yayınlama

Cloudflare panelinde Workers & Pages > Create > Import a repository ile bu depoyu seç. Derleme komutu boş, dağıtım komutu `npx wrangler deploy`.
