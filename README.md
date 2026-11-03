# RefineCalc Pro — Internal Refinery & Transport Price Calculator

An enterprise price calculation and logistics optimization engine for industrial petroleum/chemical distribution.

## Formula Implementation:
- **Net Refinery Price** = `Basic Price - Refinery Discount`
- **Customer Price** = `Net Price + Margin + Transport Freight Cost`
- **Total Order Value** = `Customer Price × Order Quantity (MT)`

## Deployment Guide (GitHub + Neon + Render):

### Step 1: Set up Neon Database
1. Go to [Neon.tech](https://neon.tech) and create a free PostgreSQL project.
2. Open the **SQL Editor** in your Neon dashboard.
3. Paste and execute the contents of `schema.sql`.
4. Copy your PostgreSQL connection string (`postgresql://user:pass@ep-xxxx.neon.tech/neondb?sslmode=require`).

### Step 2: Push to GitHub
1. Create a new GitHub repository (e.g. `refinecalc-app`).
2. Commit all files in this project:
   ```bash
   git init
   git add .
   git commit -m "Initial commit for RefineCalc internal app"
   git remote add origin <your-repo-url>
   git push -u origin main
   ```

### Step 3: Deploy on Render
1. Go to [Render.com](https://render.com) and click **New + > Web Service**.
2. Connect your GitHub repository.
3. Settings:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
4. Under **Environment Variables**, add:
   - `DATABASE_URL`: *(Your Neon Connection String)*
   - `PORT`: `10000`
5. Click **Create Web Service**. Your live URL will be ready in 1-2 minutes!
