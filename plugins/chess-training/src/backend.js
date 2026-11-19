import { createStore } from "./store.js";
import { questionSchema, answerSchema, validatePuzzle } from "./core.js";
import { lessonSchema, validateLesson } from "./lesson-core.js";
import { createAnalyzer, analysisSchema } from "./analyze.js";

export function activate(ctx) {
  const store = createStore(ctx.dataDirectory, { signal: ctx.signal });
  const analyzer = createAnalyzer(ctx.directory, ctx.signal);
  const registrations = [];
  let disposed = false;
  let disposal;
  const dispose = () => {
    if (disposal) return disposal;
    disposed = true;
    // Unregister synchronously even if activation fails, then drain CPU work before storage.
    try { for (const unregister of registrations.reverse()) unregister(); }
    finally { disposal = (async () => { try { await analyzer.dispose(); } finally { await store.dispose(); } })(); }
    return disposal;
  };
  try {
    registrations.push(ctx.handle("open-puzzle", request => {
      if (!request || typeof request !== "object" || Array.isArray(request)
        || Object.keys(request).length !== 2 || !Object.hasOwn(request, "identity") || !Object.hasOwn(request, "payload")) {
        throw new Error("Open puzzle requires only identity and payload.");
      }
      return store.open(request.identity, request.payload);
    }));
    registrations.push(ctx.handle("act-puzzle", request => store.act(request)));
    registrations.push(ctx.registerQuestionType({
      id: "puzzle",
      label: "Chess training",
      contractVersion: 1,
      showThinking: true,
      questionSchema,
      answerSchema,
      probe: {
        toolName: "chess_training_probe",
        description: "Diagnose the learner's chess understanding with an authored standard-chess puzzle on an interactive board, progressive hints and ordinary prober review.",
      },
      teach: {
        toolName: "chess_training_question",
        description: "Ask the learner to play an authored standard-chess puzzle on an interactive board, with progressive hints and ordinary teacher review.",
      },
      validateQuestion({ input }) {
        try { validatePuzzle(input.payload); }
        catch (error) { return [error instanceof Error ? error.message : String(error)]; }
        return undefined;
      },
    }));
    registrations.push(ctx.registerTools({
      agents: ["teacher"],
      create: () => [{
        name: "chess_training_lesson",
        label: "Chess lesson",
        description: "Present an interactive standard-chess lesson with one starting FEN, explanation, bounded board annotations and named legal UCI variations. This is teaching material, not a puzzle, assessment or code execution tool.",
        parameters: lessonSchema,
        async execute(_toolCallId, input, signal) {
          if (disposed || ctx.signal.aborted || signal?.aborted) throw new Error("Chess lesson cancelled");
          const lesson = validateLesson(input);
          // Native details project directly to the public renderer's output.
          // The authored tool arguments already contain the lesson for the model.
          return { content: [{ type: "text", text: "Chess lesson presented." }], details: lesson };
        },
      }],
    }));
    registrations.push(ctx.registerTools({
      agents: ["teacher", "prober"],
      create: () => [{
        name: "chess_training_analyze",
        label: "Chess engine evidence",
        description: "Analyze one full standard FEN with optional 1–8 distinct legal candidate UCI moves. Offline Stockfish.js 19.0.1 lite-single: one thread, Hash16 MiB, <=200ms/search, <=3s request including initialization. Returns finite-budget evidence, not grading or verification; FEN lacks repetition history. Busy requests are refused.",
        parameters: analysisSchema,
        async execute(_toolCallId, input, signal) {
          const evidence = await analyzer.analyze(input, signal);
          return { content: [{ type: "text", text: JSON.stringify(evidence) }], details: evidence };
        },
      }],
    }));
    registrations.push(ctx.registerInstructions({
      agents: ["teacher"],
      text: `Use chess_training_question when a chess learning task benefits from the learner playing moves on a board. The common question field is the learner-facing condition: explain the task without code or solutions in that prose. Author payload.fen as the full six-field standard-chess FEN BEFORE the first learner move; the side to move is the learner. Author payload.lines as complete legal standard UCI move sequences (explicit promotion suffix; king-destination castling), alternating learner and opponent moves. Every line must have odd length and end on a learner move. These are full lines, not just learner moves. The controller accepts authored learner alternatives and automatically plays the first compatible authored opponent reply. Authored acceptance is not a strategic guarantee or chess-engine evaluation. Author payload.hints as shared per-learner-move arrays of progressive hints, one array for each learner move up to the longest line, not separate hints for each variation. Do not put solutions in the common question prose or ask for code. After submission, use ordinary final teacher review of the full answer.moves, answer.incorrectAttempts, and answer.revealedHints in the original puzzle context; recorded retries and hint use are learning evidence, not submission-validation failures. answer.incorrectAttempts is a historical field name: it mixes illegal entries and legal moves outside authored lines. Neither its name nor its count establishes a chess mistake or learner misunderstanding.
Use chess_training_lesson to present teaching material on an interactive board, not to pose or grade a question. Supply a version 1 lesson with title, explanation, one full six-field standard-chess fen, explicit orientation ('white' or 'black'), optional initial annotations, and named variations with complete legal UCI moves from that same starting FEN. Each successful call is one immutable public lesson artifact; use additional tool calls for additional starting positions, never mutate an existing artifact. Lesson variations may have any legal length; unlike puzzle lines, they need not have odd length or end on a learner move. Optional variation annotations are indexed by ply (0 is the starting position; 1 is after the first move). Annotation fields are explanation, arrows ({from,to,color}), circles ({square,color}) and highlights ({square,color}); colors are only green, red, blue or yellow. Provide explanations and board annotations, never executable code or requests for code execution. You see authored public lesson material and native conversation content, not the learner's local board exploration: do not claim to observe selected variations, navigation or annotations, and do not infer those actions as learning evidence. For a follow-up task, author a fresh independent puzzle through chess_training_question; lesson and puzzle boards do not synchronize, and local lesson exploration does not submit an answer. Exploration exists only in the mounted card's memory, may reset on remount/reload, and is not saved or sent to you; only authored public lesson material remains in the transcript.`,
    }));
    registrations.push(ctx.registerInstructions({
      agents: ["prober"],
      text: `Use chess_training_probe for chess diagnosis that asks the learner to play moves: pose actual interactive chess puzzles, not screenshots or text-only move questions. This plugin is available through the tool; do not ask the learner to install or locate it. Supply only question and payload, without teach-only type or nodeId. The common question is the learner-facing task: do not include code or solutions. Author payload.fen as the full six-field standard-chess FEN BEFORE the first learner move; the side to move is the learner. Author payload.lines as complete legal standard UCI move sequences (explicit promotion suffix; king-destination castling), alternating learner and opponent moves. Every line must have odd length and end on a learner move. The controller accepts authored learner alternatives and automatically plays the first compatible authored opponent reply; authored acceptance is not a strategic guarantee or chess-engine evaluation. Author payload.hints as shared per-learner-move arrays of progressive hints, one array for each learner move up to the longest line, not separate hints for each variation. Hints appear only on explicit '?' requests. Completion does not submit: the learner uses the host Submit button and may explain in the optional host Your thinking field. After submission, use ordinary prober review of answer.moves, answer.incorrectAttempts, answer.revealedHints and any host thinking in the original puzzle context. Recorded retries and hint use are diagnostic evidence, not submission-validation failures. answer.incorrectAttempts is a historical field name: it mixes illegal entries and legal moves outside authored lines. Neither its name nor its count establishes a chess mistake or learner misunderstanding. Do not fabricate an assessment, skip diagnosis or force probe_done merely because this tool is available or a puzzle is completed; continue the normal evidence-based diagnosis process.`,
    }));
    registrations.push(ctx.registerInstructions({
      agents: ["teacher", "prober"],
      text: "Use the actual chess_training_analyze tool for move-strength or alternative-quality claims; do not fabricate an engine evaluation. Source/legal validation establishes legality only; authored lines establish exercise membership only; engine-supported claims must cite the returned finite-budget evidence, with score perspective, cp versus mate and any bounds. Completed means the requested bounded searches returned evidence, not that chess truth was verified. Partial, budget, cancellation or failure never means a move is wrong. Missing MultiPV/alternatives cannot prove uniqueness. FEN omits repetition history. No automatic analysis of every lesson position, continuous board analysis or whole-game analyzer is provided. This is optional evidence, not an enforced strategic admission/receipt protocol: existing authored puzzles are NOT all engine-checked. Lessons may intentionally demonstrate bad but legal moves; do not strongest-move-gate them. Legal moves outside an exercise's authored lines have unestablished quality and roll back neutrally. Host manual submission, schemas and ordinary teacher/prober review remain unchanged; do not invent authoritative grades or verified:true.",
    }));
  } catch (error) {
    void dispose();
    throw error;
  }
  return dispose;
}
