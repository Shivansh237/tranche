# Setting up Tranche for a live sandbox run

You need **six values** in `.env.local`, from four free services. Allow about 30 minutes. Nothing here costs money: every PayPal account below is a sandbox (fake money) account.

| # | Variable in `.env.local` | Where it comes from |
| --- | --- | --- |
| 1 | `DATABASE_URL` | Neon (free hosted Postgres) |
| 2 | `PAYPAL_CLIENT_ID` | PayPal Developer Dashboard, your sandbox app |
| 3 | `PAYPAL_CLIENT_SECRET` | Same app |
| 4 | `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | The same value as #2 (the browser's copy) |
| 5 | `GEMINI_API_KEY` | Google AI Studio |
| 6 | `YOUTUBE_API_KEY` | Google Cloud Console |

A seventh, `CRON_SECRET`, is a random string you generate yourself (step 0). Every other setting has a working default.

## 0. Create `.env.local`

In a terminal opened in the `Tranche` folder:

```powershell
copy .env.example .env.local
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
notepad .env.local
```

The second command prints a random string: paste it as `CRON_SECRET`. Then, as you collect each key below, replace its `<<< PASTE … >>>` placeholder, including the `<<<` and `>>>`, with no quotes and no spaces around `=`. Save the file each time.

`.env.local` is git-ignored, so your keys never get committed. Never put real keys in `.env.example`.

You will also write down three sandbox **logins** (not for `.env.local`): the platform business account, a **brand** personal account and a **creator** personal account.

Before you start, check Node.js in a terminal: `node -v` must print v22.12 or newer (v24 recommended). If it doesn't, install the LTS version from https://nodejs.org.

---

## 1. PostgreSQL database: Neon

1. Open https://neon.com and sign up (GitHub or Google sign-in is fine).
2. Create a project. Name it `tranche`, and choose the region closest to you (Singapore if you're in India).
3. On the project dashboard, click **Connect** in the top navigation. The **Connect to your branch** window opens with the connection string already filled in. Click the copy icon. It looks like
   `postgresql://neondb_owner:abc123@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`
4. Paste it as `DATABASE_URL` exactly as copied, including everything after the `?`.

Neon's free tier doesn't expire, which matters because judging runs until mid-December.

## 2. PayPal sandbox

### 2a. Developer account and app

1. Go to https://developer.paypal.com/dashboard/ and click **Log in to Dashboard**. Use any PayPal account, or sign up for one. PayPal creates your sandbox automatically, with one business and one personal test account.
2. Switch the environment toggle at the top to **Sandbox**.
3. **Create a United States business account first.** The default sandbox accounts are registered in *your* country. PayPal no longer allows India-to-India payments, so if you're in India, checkout fails with "This seller doesn't accept payments in your currency" or "Things don't appear to be working at the moment". Open **Testing Tools → Sandbox Accounts → Create account**, choose **Business** and country **United States**, and click **Create**.
4. Open **Apps & Credentials**, then click **Create App**. Fill in the form:
   - App name: `Tranche`
   - Type: **Merchant**
   - Sandbox account: the **United States** business account from step 3
   Then click **Create App**. (An app stays linked to the account it was created with, so if an existing app uses an Indian account, create a new app.)
5. On the app page, copy the **Client ID** into both `PAYPAL_CLIENT_ID` and `NEXT_PUBLIC_PAYPAL_CLIENT_ID`.
6. Reveal the **Secret** (show/eye icon) and copy it into `PAYPAL_CLIENT_SECRET`.
7. **Payouts:** in the sandbox there is no separate switch. PayPal's setup guide goes straight from **Create App** to copying the credentials. If your app page has a **Features** section with a **Payouts** checkbox, make sure it's ticked and click **Save**. `npm run smoke` prints `✓ App has the Payouts scope` when it's on. (Live Payouts is different: PayPal support must activate it on a verified business account. You don't need that for the hackathon.)

### 2b. Sandbox accounts (the people in the demo)

1. In the dashboard, open **Testing Tools → Sandbox Accounts**.
2. The **business** account (`sb-…@business.example.com`) is the platform. It receives captures and sends payouts. You don't log in as it during the demo.
3. Click **Create account** twice to make two **Personal** accounts with country **United States**. Don't use the default personal account if it's registered in India: the payment would count as domestic and PayPal would refuse it.
   - **brand**: approves funding at checkout, so it needs balance (the default balance is fine)
   - **creator**: receives payouts
4. For each one, open the account's menu (⋮) and choose **View/Edit account** to see its email and password. Write them down.
5. When you create a deal, type the **creator's** sandbox email in "Creator's PayPal email". When PayPal's checkout opens, log in as the **brand**.
6. To see money arrive, log in at https://www.sandbox.paypal.com as the creator.

## 3. Gemini API key

1. Open https://aistudio.google.com/apikey and sign in with a Google account.
2. Click **Create API key**, picking an existing Google Cloud project or letting it create one.
3. Copy the key into `GEMINI_API_KEY`.

Leave `GEMINI_MODEL=gemini-3.8-flash`. Gemini 1.5 is retired, and 2.5 only works for projects that already used it.

## 4. YouTube Data API v3 key

1. Open https://console.cloud.google.com. In the project picker at the top, choose the same project as the Gemini key (or create one).
2. Go to **APIs & Services → Library**, search **YouTube Data API v3**, open it and click **Enable**.
3. Go to **APIs & Services → Credentials → + Create credentials → API key**. Copy the key into `YOUTUBE_API_KEY`.
4. Recommended: click the new key, set **API restrictions → Restrict key → YouTube Data API v3**, and save.

Each audit uses about 3 units of the free 10,000-unit daily quota.

---

## 5. Day-1 smoke test: one command

With `.env.local` filled in, run this from the `Tranche` folder:

```powershell
npm run smoke -- --channel=@yourhandle --video=<id of one of your PUBLIC videos>
```

It creates the database tables, then checks each connection:

- Postgres is reachable and migrated.
- PayPal: OAuth works, the Payouts scope is present, and a real sandbox `AUTHORIZE` order can be created.
- YouTube: your channel handle resolves.
- Gemini: it answers, and actually watches your public video.

Every line should show ✓. Fix any ✗ before going further: the line names what failed.

The video id is the part after `v=` in `https://www.youtube.com/watch?v=dQw4w9WgXcQ`. The video must be **public**; unlisted or private videos fail the Gemini check by design.

## 6. Your first live deal

```powershell
npm run dev
```

1. **Write the deal** at **http://localhost:3000/deals/new**. For a first test, keep it small and reachable:
   > Lumen Skincare pays $300 for one YouTube video about the Glow Serum. $200 when the video goes live with at least 20 seconds focused on the Glow Serum, the words "Glow Serum" said on camera, and an #ad disclosure, published within 7 days. $100 bonus if the video reaches 5 views within 14 days.
   - **Creator's PayPal email:** the **creator** sandbox email (`sb-…@personal.example.com`). This is the only account the deal can ever pay.
   - **Creator's YouTube channel:** *your* channel's handle, where you will upload the test video.
   - Click **Compile contract**. The button counts the seconds while Gemini works; check the tranches it shows.
2. **Fund it.** Click the PayPal button. In the PayPal window, log in with the **brand** sandbox account (not the business account: PayPal won't let the platform pay itself) and approve. The window closes and you land on the live dashboard at `http://localhost:3000/deals/<deal id>`, showing the authorized balance.
3. **Upload a new video, after funding.** Only a video published **after** the deal was funded, on the contracted channel, set to **Public**, can pay. Older videos, unlisted or private ones are ignored. A phone clip is fine: about 20+ seconds showing any bottle while you say "Glow Serum", with **#ad** in the description.
4. **Wait a few minutes** after YouTube finishes processing (new uploads take a little while to appear in the YouTube API), then click **Run audit** on the dashboard. Or leave `npm run poll -- --every=15` running in a second terminal to check automatically.
5. **Watch the money move.** The timeline shows the upload, Gemini's observations, the Spend Firewall's 22 rules, the capture and the payout. Log in at https://www.sandbox.paypal.com as the **creator** to see the payout arrive.

**Want to see the dashboard filled in before you have a real video?** Against your fresh Neon database, run `npm run simulate -- --pg`. It creates three demo deals with simulated PayPal, YouTube and Gemini responses and **wipes Tranche's tables first**, so only do this before real deals exist. Then refresh http://localhost:3000.
