# إعداد وتشغيل المشروع

## المتطلبات التي تم فحصها

- Windows 10 Pro، الإصدار `10.0.19045`، معمارية x64.
- Node.js `24.13.0`، وnpm `11.6.2`، وGit `2.52.0`، وVS Code `1.139.1`.
- مساحة حرة وقت الفحص: `89.2 GB`.
- لا يوجد Docker أو MySQL أو SQLite CLI؛ ليست مطلوبة لهذا المشروع.

## التثبيت الأول

من PowerShell:

```powershell
Set-Location 'C:\Users\HP\Desktop\Friend Feud\friend-feud'
Copy-Item .env.example .env
npm install
```

يلزم اتصال إنترنت لتنزيل الحزم أول مرة فقط. لا تضع أسرارًا في `.env` أو Git.

## تشغيل الواجهة والخادم

```powershell
npm run dev
```

أو تشغيل كل جزء منفردًا:

```powershell
npm run dev:web
npm run dev:api
```

عناوين المضيف الافتراضية:

- الواجهة: `http://localhost:5173`
- فحص API: `http://localhost:3000/health`

## أجهزة الشبكة المحلية

1. صِل اللابتوب والهواتف إلى شبكة Wi-Fi نفسها.
2. اعرف عنوان IPv4 المحلي:

   ```powershell
   Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object InterfaceAlias, IPAddress
   ```

3. افتح من الهاتف `http://<عنوان-IPv4>:5173/team-one`، أو مسارات العرض الأخرى.
4. اضبط `WEB_ORIGIN` في `.env` ليتضمن عنوان الواجهة الفعلي إذا احتاج المتصفح اتصالًا عابرًا للمنافذ.

قد يمنع جدار حماية Windows الاتصالات الواردة. اسمح لـ Node.js على الشبكة الخاصة عند الحاجة؛ لا توقف جدار الحماية ولا تغيّر إعداداته تلقائيًا. اتصال Socket.IO الحالي تشخيصي فقط.

## قاعدة البيانات والمهاجرات

ملف SQLite المحلي هو `data/friend-feud.sqlite`. ينشئه الخادم عند بدء TypeORM؛ لا تفتحه من جهاز آخر. `synchronize` معطل ولا توجد جداول لعبة.

بعد إضافة migration مستقبلًا، شغّلها يدويًا:

```powershell
npm run db:migrate
```

## التحقق

```powershell
npm run check:env
npm run build
npm test
npm run test:e2e --workspace @friend-feud/api
```

اختبار end-to-end يتحقق من HTTP ومن ping/pong عبر Socket.IO.
