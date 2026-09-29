# Adds a "diagnostics only" mode to a copy of the reference's test harness: with CTP_MODE=diag a case is checked
# once (config, program, syntactic, semantic and global diagnostics, suggestions when the case asks), nothing is
# emitted, no declaration diagnostics are made, an incremental case uses the plain program, and only the error
# baseline is compared. Without CTP_MODE the harness is unchanged.
# usage: python3 patch.py <copy of the reference>
import sys
T=sys.argv[1]
p=T+'/internal/testutil/harnessutil/harnessutil.go'
s=open(p).read()
a='''	ctx := context.Background()

	var preErrors []*ast.Diagnostic
'''
assert s.count(a)==1
s=s.replace(a,'''	ctx := context.Background()

	if os.Getenv("CTP_MODE") == "diag" {
		diagProgram := createProgram(host, config)
		var diagErrors []*ast.Diagnostic
		diagErrors = append(diagErrors, diagProgram.GetConfigFileParsingDiagnostics()...)
		diagErrors = append(diagErrors, diagProgram.GetProgramDiagnostics()...)
		diagErrors = append(diagErrors, diagProgram.GetSyntacticDiagnostics(ctx, nil)...)
		diagErrors = append(diagErrors, diagProgram.GetSemanticDiagnostics(ctx, nil)...)
		diagErrors = append(diagErrors, diagProgram.GetGlobalDiagnostics(ctx)...)
		if harnessOptions.CaptureSuggestions {
			diagErrors = append(diagErrors, diagProgram.GetSuggestionDiagnostics(ctx, nil)...)
		}
		diagErrors = compiler.SortAndDeduplicateDiagnostics(diagErrors)
		return newCompilationResult(host, config.CompilerOptions(), diagProgram, nil, diagErrors, harnessOptions)
	}

	var preErrors []*ast.Diagnostic
''')
a='	if config.CompilerOptions().Incremental.IsTrue() {\n		oldProgram := incremental.ReadBuildInfoProgram'
assert s.count(a)==1
s=s.replace(a,'	if os.Getenv("CTP_MODE") != "diag" && config.CompilerOptions().Incremental.IsTrue() {\n		oldProgram := incremental.ReadBuildInfoProgram')
open(p,'w').write(s)
p=T+'/internal/testrunner/compiler_runner.go'
s=open(p).read()
a='''	compilerTest.verifyDiagnostics(t, r.testSuitName, r.isSubmodule)
	compilerTest.verifyContentMapper'''
assert s.count(a)==1
s=s.replace(a,'''	compilerTest.verifyDiagnostics(t, r.testSuitName, r.isSubmodule)
	if os.Getenv("CTP_MODE") == "diag" {
		return
	}
	compilerTest.verifyContentMapper''')
open(p,'w').write(s)
print('patched',T)
