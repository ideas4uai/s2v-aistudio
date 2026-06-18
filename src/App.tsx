import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { ProjectDetail } from './pages/ProjectDetail';
import { CreateProject } from './pages/CreateProject';
import { ProjectEditor } from './pages/ProjectEditor';
import { UniverseEditor } from './pages/UniverseEditor';
import { CharacterOnboarding } from './pages/CharacterOnboarding';
import { Layout } from './components/Layout';
import { QuotaProvider } from './contexts/QuotaContext';
import { AuthProvider } from './contexts/AuthContext';
import { ApiKeyGuard } from './components/ApiKeyGuard';

export default function App() {
  return (
    <Router>
      <AuthProvider>
        <ApiKeyGuard>
          <QuotaProvider>
            <Layout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/projects/new" element={<CreateProject />} />
                <Route path="/projects/:id" element={<ProjectDetail />} />
                <Route path="/projects/:id/edit" element={<ProjectEditor />} />
                <Route path="/universes/:id" element={<UniverseEditor />} />
                <Route path="/characters/new" element={<CharacterOnboarding />} />
              </Routes>
            </Layout>
          </QuotaProvider>
        </ApiKeyGuard>
      </AuthProvider>
    </Router>
  );
}
