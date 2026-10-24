"use client";

import { useState, useEffect, useCallback } from "react";
import { Save, Plus, X } from "lucide-react";
import Link from "next/link";

interface AutoReplySettings {
  id: string;
  enabled: boolean;
  autoSendToKnown: boolean;
  responseTemplate: string | null;
  responseTone: "professional" | "friendly" | "formal";
  excludeSenders: string[];
  excludeSubjects: string[];
}

function OnOffControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex shrink-0 rounded-lg border border-slate-200 bg-slate-100 p-1"
    >
      <button
        type="button"
        aria-pressed={value}
        onClick={() => onChange(true)}
        className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
          value
            ? "bg-emerald-600 text-white shadow-sm"
            : "text-slate-600 hover:text-slate-900"
        }`}
      >
        On
      </button>
      <button
        type="button"
        aria-pressed={!value}
        onClick={() => onChange(false)}
        className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
          !value
            ? "bg-slate-700 text-white shadow-sm"
            : "text-slate-600 hover:text-slate-900"
        }`}
      >
        Off
      </button>
    </div>
  );
}

export default function AutoReplySettingsPage() {
  const [settings, setSettings] = useState<AutoReplySettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [newExcludeSender, setNewExcludeSender] = useState("");
  const [newExcludeSubject, setNewExcludeSubject] = useState("");

  const loadSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/auto-reply");
      if (response.ok) {
        const data = await response.json();
        setSettings(data);
      }
    } catch (error) {
      console.error("Failed to load settings:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadSettings);
  }, [loadSettings]);

  async function saveSettings() {
    if (!settings) return;
    setIsSaving(true);

    try {
      const response = await fetch("/api/settings/auto-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });

      if (response.ok) {
        alert("Settings saved successfully!");
      } else {
        alert("Failed to save settings");
      }
    } catch (error) {
      console.error("Save error:", error);
      alert("Error saving settings");
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-slate-600">Loading settings...</div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <h1 className="text-3xl font-bold mb-6">Auto-Reply Settings</h1>
        <p className="text-red-600">Failed to load settings. Please try again.</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="mb-6">
        <Link href="/" className="text-blue-600 hover:underline text-sm">
          ← Back to Inbox
        </Link>
      </div>

      <h1 className="text-3xl font-bold mb-8">Auto-Reply Settings</h1>

      <div className="bg-white rounded-lg shadow p-6 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 p-4">
          <div>
            <p className="text-base font-semibold text-slate-900">
              Automatic reply generation
            </p>
            <p className="mt-1 max-w-md text-xs leading-5 text-slate-500">
              When on, create replies for newly synced incoming mail. Existing inbox history is not processed automatically.
            </p>
          </div>
          <OnOffControl
            label="Automatic reply generation"
            value={settings.enabled}
            onChange={(enabled) => setSettings({ ...settings, enabled })}
          />
        </div>

        {settings.enabled && (
          <>
            {/* Response Tone */}
            <div>
              <label className="block text-sm font-medium mb-2">
                Response Tone
              </label>
              <select
                value={settings.responseTone}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    responseTone: e.target.value as AutoReplySettings["responseTone"],
                  })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="professional">Professional</option>
                <option value="friendly">Friendly</option>
                <option value="formal">Formal</option>
              </select>
            </div>

            {/* Response Template */}
            <div>
              <label className="block text-sm font-medium mb-2">
                Response Template (Optional)
              </label>
              <textarea
                value={settings.responseTemplate || ""}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    responseTemplate: e.target.value,
                  })
                }
                placeholder="Leave empty for AI to generate contextual responses. Add a template to guide responses."
                rows={4}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
              />
            </div>

            {/* Auto-send setting */}
            <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-slate-200 p-4">
              <div>
                <p className="text-sm font-medium text-slate-900">
                  Automatic email sending
                </p>
                <p className="mt-1 max-w-md text-xs leading-5 text-slate-500">
                  Only replies marked very low-risk and at least 90% confident are sent. Other replies remain drafts for review.
                </p>
              </div>
              <OnOffControl
                label="Automatic email sending"
                value={settings.autoSendToKnown}
                onChange={(autoSendToKnown) =>
                  setSettings({ ...settings, autoSendToKnown })
                }
              />
            </div>

            {/* Exclude Senders */}
            <div>
              <label className="block text-sm font-medium mb-2">
                Exclude Senders (No auto-reply)
              </label>
              <div className="space-y-2 mb-3">
                {settings.excludeSenders.map((sender, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between bg-slate-100 px-3 py-2 rounded"
                  >
                    <span className="text-sm">{sender}</span>
                    <button
                      onClick={() =>
                        setSettings({
                          ...settings,
                          excludeSenders: settings.excludeSenders.filter(
                            (_, i) => i !== idx
                          ),
                        })
                      }
                      className="text-red-600 hover:text-red-700"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={newExcludeSender}
                  onChange={(e) => setNewExcludeSender(e.target.value)}
                  placeholder="email@example.com"
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                />
                <button
                  onClick={() => {
                    if (
                      newExcludeSender &&
                      !settings.excludeSenders.includes(newExcludeSender)
                    ) {
                      setSettings({
                        ...settings,
                        excludeSenders: [
                          ...settings.excludeSenders,
                          newExcludeSender,
                        ],
                      });
                      setNewExcludeSender("");
                    }
                  }}
                  className="px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2"
                >
                  <Plus className="h-4 w-4" />
                  Add
                </button>
              </div>
            </div>

            {/* Exclude Subjects */}
            <div>
              <label className="block text-sm font-medium mb-2">
                Exclude Subjects (patterns)
              </label>
              <div className="space-y-2 mb-3">
                {settings.excludeSubjects.map((subject, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between bg-slate-100 px-3 py-2 rounded"
                  >
                    <span className="text-sm">{subject}</span>
                    <button
                      onClick={() =>
                        setSettings({
                          ...settings,
                          excludeSubjects: settings.excludeSubjects.filter(
                            (_, i) => i !== idx
                          ),
                        })
                      }
                      className="text-red-600 hover:text-red-700"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newExcludeSubject}
                  onChange={(e) => setNewExcludeSubject(e.target.value)}
                  placeholder="e.g., Newsletter, Notification, etc."
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                />
                <button
                  onClick={() => {
                    if (
                      newExcludeSubject &&
                      !settings.excludeSubjects.includes(newExcludeSubject)
                    ) {
                      setSettings({
                        ...settings,
                        excludeSubjects: [
                          ...settings.excludeSubjects,
                          newExcludeSubject,
                        ],
                      });
                      setNewExcludeSubject("");
                    }
                  }}
                  className="px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2"
                >
                  <Plus className="h-4 w-4" />
                  Add
                </button>
              </div>
            </div>
          </>
        )}

        {/* Save Button */}
        <button
          onClick={saveSettings}
          disabled={isSaving}
          className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2 font-medium"
        >
          <Save className="h-5 w-5" />
          {isSaving ? "Saving..." : "Save Settings"}
        </button>
        <p className="text-center text-xs text-slate-500">
          Changes to these On/Off controls are applied when you save settings.
        </p>
      </div>

      {/* Info Section */}
      <div className="mt-8 p-4 bg-blue-50 rounded-lg">
        <h3 className="font-semibold text-blue-900 mb-2">How it works:</h3>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>• AI analyzes each incoming email to determine reply appropriateness</li>
          <li>• High-confidence, low-risk replies are sent automatically when the option above is enabled</li>
          <li>• Uncertain or sensitive replies are saved as drafts for your review</li>
          <li>• Excluded senders and subjects will never get auto-replies</li>
          <li>• All replies are logged for your audit trail</li>
        </ul>
      </div>
    </div>
  );
}
