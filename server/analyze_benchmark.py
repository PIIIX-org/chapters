import json
import statistics

# 1. Load Client Benchmark Results
with open("benchmark_results.json", "r") as f:
    bench_data = json.load(f)

# 2. Load Server Telemetry
telemetry = []
with open("telemetry_benchmark.jsonl", "r") as f:
    for line in f:
        line = line.strip()
        if line:
            telemetry.append(json.loads(line))

print(f"Loaded {len(telemetry)} telemetry records.")

# Helper to slice telemetry in epoch range [start_epoch_ms, end_epoch_ms]
def get_telemetry_window(start_ms, end_ms):
    # telemetry timestamp is in float seconds
    s_sec = start_ms / 1000.0
    e_sec = end_ms / 1000.0
    return [t for t in telemetry if s_sec <= t["timestamp"] <= e_sec]

def summarize_container(records, container_name):
    cpus = [r["containers"][container_name]["cpu_pct"] for r in records if container_name in r["containers"]]
    mems = [r["containers"][container_name]["mem_mb"] for r in records if container_name in r["containers"]]
    if not cpus:
        return {"cpu_avg": 0, "cpu_max": 0, "mem_avg": 0, "mem_max": 0, "mem_min": 0}
    return {
        "cpu_avg": round(statistics.mean(cpus), 2),
        "cpu_max": round(max(cpus), 2),
        "mem_avg": round(statistics.mean(mems), 2),
        "mem_max": round(max(mems), 2),
        "mem_min": round(min(mems), 2),
        "mem_delta": round(max(mems) - min(mems), 2)
    }

def summarize_system(records):
    cpus = [r["system"]["cpu_pct"] for r in records]
    loads = [r["system"]["loadavg"][0] for r in records]
    if not cpus:
        return {"cpu_avg": 0, "cpu_max": 0, "load_max": 0}
    return {
        "cpu_avg": round(statistics.mean(cpus), 2),
        "cpu_max": round(max(cpus), 2),
        "load_max": round(max(loads), 2)
    }

report = {}

for target_key in ["mcppgvector", "choromamcp"]:
    target_data = bench_data[target_key]
    target_report = {
        "title": target_data["title"],
        "totalDurationSec": round(target_data["totalDurationMs"] / 1000.0, 1),
        "phases": []
    }
    
    # overall telemetry
    target_window = get_telemetry_window(target_data["startMs"], target_data["endMs"])
    target_report["system_overall"] = summarize_system(target_window)
    
    if target_key == "mcppgvector":
        target_report["app_overall"] = summarize_container(target_window, "elara_pgvector_app")
        target_report["db_overall"] = summarize_container(target_window, "elara_pgvector_db")
    else:
        target_report["app_overall"] = summarize_container(target_window, "elara_chroma_app")
        target_report["db_overall"] = summarize_container(target_window, "elara_chroma_db")
        target_report["chroma_server_overall"] = summarize_container(target_window, "elara_chroma_server")

    for p in target_data["phases"]:
        p_window = get_telemetry_window(p["startMs"], p["endMs"])
        p_summary = {
            "phase": p["phase"],
            "title": p["title"],
            "durationSec": round(p["durationMs"] / 1000.0, 2),
            "stats": p["stats"],
            "system": summarize_system(p_window),
        }
        if target_key == "mcppgvector":
            p_summary["app"] = summarize_container(p_window, "elara_pgvector_app")
            p_summary["db"] = summarize_container(p_window, "elara_pgvector_db")
        else:
            p_summary["app"] = summarize_container(p_window, "elara_chroma_app")
            p_summary["db"] = summarize_container(p_window, "elara_chroma_db")
            p_summary["chroma_server"] = summarize_container(p_window, "elara_chroma_server")
            
        target_report["phases"].append(p_summary)
        
    report[target_key] = target_report

with open("benchmark_analysis_summary.json", "w") as f:
    json.dump(report, f, indent=2)

print("\n=======================================================")
print("COMPARATIVE SUMMARY ACROSS 8 PHASES")
print("=======================================================\n")

for i in range(8):
    p_pg = report["mcppgvector"]["phases"][i]
    p_ch = report["choromamcp"]["phases"][i]
    print(f"Phase {p_pg['phase']}: {p_pg['title']}")
    print(f"  Duration:   PGVector = {p_pg['durationSec']}s | Chroma = {p_ch['durationSec']}s")
    print(f"  Throughput: PGVector = {p_pg['stats']['rps']} QPS | Chroma = {p_ch['stats']['rps']} QPS")
    print(f"  Latency p50: PGVector = {p_pg['stats']['p50Ms']}ms | Chroma = {p_ch['stats']['p50Ms']}ms")
    print(f"  Latency p95: PGVector = {p_pg['stats']['p95Ms']}ms | Chroma = {p_ch['stats']['p95Ms']}ms")
    print(f"  App CPU Avg: PGVector = {p_pg['app']['cpu_avg']}% | Chroma = {p_ch['app']['cpu_avg']}%")
    print(f"  App Mem Peak: PGVector = {p_pg['app']['mem_max']} MB | Chroma = {p_ch['app']['mem_max']} MB")
    if "chroma_server" in p_ch:
        print(f"  Chroma Server CPU Avg: {p_ch['chroma_server']['cpu_avg']}%, Mem: {p_ch['chroma_server']['mem_max']} MB")
    print()

print("OVERALL HARDWARE CONSUMPTION:")
print(f"PGVector Total Time: {report['mcppgvector']['totalDurationSec']}s")
print(f"  App CPU Avg: {report['mcppgvector']['app_overall']['cpu_avg']}%, Peak: {report['mcppgvector']['app_overall']['cpu_max']}%")
print(f"  App RAM: Start={report['mcppgvector']['app_overall']['mem_min']}MB, Peak={report['mcppgvector']['app_overall']['mem_max']}MB (Delta: +{report['mcppgvector']['app_overall']['mem_delta']}MB)")
print(f"  DB  CPU Avg: {report['mcppgvector']['db_overall']['cpu_avg']}%, Peak: {report['mcppgvector']['db_overall']['cpu_max']}%")
print(f"  DB  RAM: Start={report['mcppgvector']['db_overall']['mem_min']}MB, Peak={report['mcppgvector']['db_overall']['mem_max']}MB")

print(f"\nChroma Total Time: {report['choromamcp']['totalDurationSec']}s")
print(f"  App CPU Avg: {report['choromamcp']['app_overall']['cpu_avg']}%, Peak: {report['choromamcp']['app_overall']['cpu_max']}%")
print(f"  App RAM: Start={report['choromamcp']['app_overall']['mem_min']}MB, Peak={report['choromamcp']['app_overall']['mem_max']}MB (Delta: +{report['choromamcp']['app_overall']['mem_delta']}MB)")
print(f"  DB  CPU Avg: {report['choromamcp']['db_overall']['cpu_avg']}%, Peak: {report['choromamcp']['db_overall']['cpu_max']}%")
print(f"  DB  RAM: Start={report['choromamcp']['db_overall']['mem_min']}MB, Peak={report['choromamcp']['db_overall']['mem_max']}MB")
print(f"  Chroma Server CPU Avg: {report['choromamcp']['chroma_server_overall']['cpu_avg']}%, Peak: {report['choromamcp']['chroma_server_overall']['cpu_max']}%")
print(f"  Chroma Server RAM: Start={report['choromamcp']['chroma_server_overall']['mem_min']}MB, Peak={report['choromamcp']['chroma_server_overall']['mem_max']}MB (Delta: +{report['choromamcp']['chroma_server_overall']['mem_delta']}MB)")
