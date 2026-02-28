import { useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

type Provider = "openai";

interface StepConfigureLLMProps {
	initialProvider?: Provider;
	initialConnected?: boolean;
	onNext: (data: {
		provider: Provider;
		connected: boolean;
	}) => void;
}

export function StepConfigureLLM({ initialProvider, initialConnected, onNext }: StepConfigureLLMProps) {
	const provider: Provider = initialProvider ?? "openai";
	const [openAiApiKey, setOpenAiApiKey] = useState("");
	const [openAiBaseUrl, setOpenAiBaseUrl] = useState("https://api.minimax.io/v1");
	const [openAiModel, setOpenAiModel] = useState("MiniMax-M2.5-highspeed");
	const [isConnected, setIsConnected] = useState(initialConnected ?? false);
	const [error, setError] = useState("");

	const handleContinue = () => {
		onNext({
			provider,
			connected: isConnected,
		});
	};

	const canConnect = openAiApiKey.trim().length > 0 && openAiBaseUrl.trim().length > 0 && openAiModel.trim().length > 0;

	const llmMutation = useMutation({
		mutationFn: async () => {
			const payload = {
				provider,
				apiKey: openAiApiKey.trim(),
				baseUrl: openAiBaseUrl.trim(),
				model: openAiModel.trim(),
			};
			await api.setup.verifyLlm(payload);
			await api.setup.llm(payload);
		},
		onSuccess: () => {
			setIsConnected(true);
			setOpenAiApiKey("");
			toast.success(`Connected to OpenAI-Compatible using ${openAiModel.trim()}.`);
		},
		onError: (err: Error) => {
			setError(err.message);
		},
	});

	const isVerifying = llmMutation.isPending;

	const handleConnect = () => {
		setError("");
		if (!canConnect) return;
		llmMutation.mutate();
	};

	return (
		<div className="w-full max-w-[520px]">
			<div className="mb-1">
				<h1 className="text-xl font-semibold">Connect your LLM</h1>
			</div>
			<p className="mb-6 text-sm text-muted-foreground">
				Papert Claw uses OpenAI-compatible configuration from your onboarding values.
			</p>

			{isConnected ? (
				<div className="space-y-6">
					<div className="rounded-lg border bg-card p-5">
						<div className="flex items-center gap-3">
							<div className="flex size-10 items-center justify-center rounded-full bg-success/10">
								<span className="text-sm font-semibold text-success">✓</span>
							</div>
							<div>
								<p className="text-sm font-medium">Connected to OpenAI-Compatible</p>
								<p className="text-xs text-muted-foreground">Using {openAiModel}</p>
							</div>
						</div>
					</div>
					<Button className="w-full" onClick={handleContinue}>
						Continue
					</Button>
				</div>
			) : (
				<div className="space-y-4">
					<div className="rounded-lg border bg-card p-4">
						<div className="mb-1.5 flex items-center gap-2">
							<svg className="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
								<title>OpenAI-compatible</title>
								<path d="M12 3a9 9 0 1 1-9 9 9 9 0 0 1 9-9zm0 2.5a6.5 6.5 0 1 0 6.5 6.5A6.5 6.5 0 0 0 12 5.5z" />
							</svg>
							<span className="text-sm font-medium">OpenAI-Compatible</span>
						</div>
						<p className="text-xs text-muted-foreground">Provide OPENAI_API_KEY, OPENAI_BASE_URL, and OPENAI_MODEL</p>
					</div>

					<div className="space-y-3">
						<div className="space-y-1.5">
							<Label htmlFor="openAiApiKey" className="text-xs">
								OPENAI API Key
							</Label>
							<Input
								id="openAiApiKey"
								type="password"
								value={openAiApiKey}
								onChange={(e) => setOpenAiApiKey(e.target.value)}
								placeholder="sk-api-..."
								disabled={isVerifying}
								className="font-mono text-xs"
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="openAiBaseUrl" className="text-xs">
								OPENAI Base URL
							</Label>
							<Input
								id="openAiBaseUrl"
								value={openAiBaseUrl}
								onChange={(e) => setOpenAiBaseUrl(e.target.value)}
								placeholder="https://api.minimax.io/v1"
								disabled={isVerifying}
								className="font-mono text-xs"
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="openAiModel" className="text-xs">
								OPENAI Model
							</Label>
							<Input
								id="openAiModel"
								value={openAiModel}
								onChange={(e) => setOpenAiModel(e.target.value)}
								placeholder="MiniMax-M2.5-highspeed"
								disabled={isVerifying}
								className="font-mono text-xs"
							/>
						</div>
					</div>

					{error && <p className="text-xs text-destructive">{error}</p>}

					<p className="text-xs text-muted-foreground">
						The server will use OPENAI_API_KEY, OPENAI_BASE_URL, and OPENAI_MODEL from onboarding.
					</p>

					<Button className="w-full" onClick={handleConnect} disabled={!canConnect || isVerifying}>
						Connect
					</Button>
				</div>
			)}
		</div>
	);
}
