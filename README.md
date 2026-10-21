# DataBridge - AI-Powered Data Migration Platform

DataBridge is an intelligent data migration platform that automates the process of migrating data from CSV files to Microsoft Dynamics 365. It uses AI to suggest field mappings, validate data, apply cleansing transformations, and execute migrations with real-time progress tracking.

## 🚀 Features

- **Smart Upload & Schema Profiling**: Upload CSV files and automatically profile data types, patterns, and quality metrics
- **AI-Powered Field Mapping**: Groq AI suggests optimal field mappings to Dynamics 365 entities with confidence scores
- **Data Validation**: Comprehensive validation rules (required fields, data types, formats, length constraints)
- **Intelligent Cleansing**: Natural language data transformation with SQL preview and execution
- **Real-Time Migration**: WebSocket-based live migration progress with batch processing
- **Comprehensive Reporting**: Detailed migration reports with success rates, error analysis, and downloadable exports
- **Audit Trail**: Complete audit log of all operations for compliance and debugging
- **Multi-Source Import**: Connect to 50+ data sources via PyAirbyte (Salesforce, MySQL, PostgreSQL, HubSpot, etc.)
- **Global Error Handling**: Robust error handling with user-friendly messages
- **Test Coverage**: Comprehensive test suites for backend and frontend
- **Project Management**: List, view, and manage multiple migration projects

## 📁 Project Structure

```
databridge/
├── Databridge_backend/          # FastAPI Python backend
│   ├── app/
│   │   ├── config/              # Configuration and D365 field definitions
│   │   ├── models/              # Pydantic schemas
│   │   ├── routes/              # API endpoints
│   │   └── services/            # Business logic (DuckDB, PostgreSQL, Dataverse)
│   ├── database_setup.sql       # PostgreSQL schema initialization
│   ├── requirements.txt         # Python dependencies
│   └── .env.example            # Environment variables template
│
└── databridge-ui/               # React + TypeScript frontend
    ├── src/
    │   ├── components/          # Reusable UI components
    │   ├── pages/               # Main application pages
    │   ├── services/            # API client
    │   └── context/             # React context for state management
    ├── package.json
    └── vite.config.ts          # Vite configuration with WebSocket proxy
```

## 🛠️ Tech Stack

### Backend
- **FastAPI** - Modern Python web framework
- **PostgreSQL** - Metadata storage (projects, mappings, audit logs)
- **DuckDB** - In-memory analytics for data processing
- **SQLAlchemy** - Database ORM
- **Groq AI** - LLM for intelligent field mapping
- **MSAL** - Microsoft Authentication Library for Dynamics 365
- **WebSockets** - Real-time migration progress streaming

### Frontend
- **React 18** - UI framework
- **TypeScript** - Type-safe JavaScript
- **Vite** - Fast build tool
- **React Router** - Client-side routing
- **Tailwind CSS** - Utility-first styling
- **Recharts** - Data visualization
- **Lucide React** - Icon library

## 📋 Prerequisites

- **Python 3.11+**
- **Node.js 18+** and npm
- **PostgreSQL 14+** (or Neon serverless PostgreSQL)
- **Groq API Key** (for AI mapping)
- **Microsoft Dynamics 365** credentials (optional - simulation mode available)

## 🚀 Setup Instructions

### 1. Backend Setup

```bash
cd databridge/Databridge_backend

# Create virtual environment
python -m venv venv

# Activate virtual environment
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# .env file is already included with team credentials
# No additional configuration needed!
```

### 2. Database Setup

```bash
# Run the database setup script in PostgreSQL
psql -U your_username -d your_database -f database_setup.sql

# Or if using Neon/cloud PostgreSQL:
# Copy the contents of database_setup.sql and run in the SQL editor
```

### 3. Frontend Setup

```bash
cd databridge/databridge-ui

# Install dependencies
npm install

# Create .env file (optional - defaults to localhost:8001)
echo "VITE_API_BASE_URL=http://localhost:8001" > .env
```

### 4. Run the Application

**Terminal 1 - Backend:**
```bash
cd databridge/Databridge_backend
venv\Scripts\activate  # or source venv/bin/activate on macOS/Linux
uvicorn app.main:app --reload --port 8001
```

**Terminal 2 - Frontend:**
```bash
cd databridge/databridge-ui
npm run dev
```

Access the application at: **http://localhost:3000**

## 🔧 Configuration

### Environment Variables

**Backend (.env):**
```env
# PostgreSQL Database
DATABASE_URL=postgresql://user:password@host:5432/database

# Groq AI API
GROQ_API_KEY=your_groq_api_key_here

# Dynamics 365 (Optional - leave empty for simulation mode)
D365_TENANT_ID=your_tenant_id
D365_CLIENT_ID=your_client_id
D365_CLIENT_SECRET=your_client_secret
D365_RESOURCE_URL=https://yourorg.crm.dynamics.com
```

**Frontend (.env):**
```env
VITE_API_BASE_URL=http://localhost:8001
```

## 📖 Usage Workflow

1. **Upload**: Upload a CSV file with source data
2. **Schema**: Review auto-detected schema and data quality metrics
3. **Mapping**: Review AI-suggested field mappings, approve or override
4. **Validation**: Run validation rules and review errors
5. **Cleansing**: Apply data transformations using natural language
6. **Migration**: Execute migration with real-time progress tracking
7. **Report**: View comprehensive migration report and download exports

## 🧪 Testing

### Backend Tests
```bash
cd databridge/Databridge_backend

# Run all tests
pytest

# Run with verbose output
pytest -v

# Run with coverage
pytest --cov=app tests/

# Run specific test file
pytest tests/test_api.py
```

### Frontend Tests
```bash
cd databridge/databridge-ui

# Run tests
npm run test

# Run tests with UI
npm run test:ui

# Run tests with coverage
npm run test:coverage
```

### Run All Tests (Windows)
```bash
# From project root
run_tests.bat
```

## 📦 Deployment

### Backend Deployment (Example: Railway/Render)
1. Set environment variables in platform dashboard
2. Deploy from Git repository
3. Run database migrations
4. Set start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`

### Frontend Deployment (Example: Vercel/Netlify)
1. Build the project: `npm run build`
2. Deploy the `dist` folder
3. Set environment variable: `VITE_API_BASE_URL=https://your-backend-url.com`

## 🔒 Security Notes

- The `.env` file is included in the repository for team collaboration
- Team members share the same credentials
- Keep the repository private - do not share publicly
- Enable CORS only for trusted origins in production
- Use HTTPS in production environments
- Implement proper authentication/authorization for production use

## 🐛 Troubleshooting

### WebSocket Connection Issues
- Ensure `websockets` package is installed: `pip install websockets`
- Check Vite proxy configuration in `vite.config.ts`
- Verify backend is running on the correct port

### Database Connection Issues
- Verify PostgreSQL is running and accessible
- Check DATABASE_URL format and credentials
- For Neon: Ensure SSL mode is enabled

### AI Mapping Not Working
- Verify GROQ_API_KEY is set correctly
- Check API quota/limits at https://console.groq.com
- Review backend logs for API errors

## 📝 License

This project is proprietary software. All rights reserved.

## 👥 Team

For questions or support, contact your team lead.

## 🔄 Version History

- **v1.1.0** - Integration Complete (June 2026) 
  - Added Projects Management API
  - Global error handling (backend & frontend)
  - Comprehensive test suites
  - Error boundary for React
  - Backend-first API with localStorage fallback
  - Fixed all integration gaps
- **v1.0.0** - Initial release with core migration features
  - WebSocket support for real-time progress
  - AI-powered field mapping
  - Comprehensive validation and cleansing
