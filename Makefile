.PHONY: audit-scenario audit-report audit-demo audit-clean

# トラフィック生成（3ユーザーのログイン+API呼び出し。Token Exchangeチェーンを実際に発生させる）
audit-scenario:
	docker compose --profile audit run --rm scenario

# 直近1時間のログを突合して監査レポートを出す
audit-report:
	docker compose --profile audit run --rm audit

# シナリオ実行→監査→後片付けを一括実行。
# audit-report は異常検知時に意図的に exit 1 する（audit.py参照）ため、
# 素直に prerequisite にすると make がそこで止まり audit-clean が実行されない。
# 終了コードを保持しつつ、後片付けは必ず走らせる。
audit-demo:
	$(MAKE) audit-scenario
	@$(MAKE) audit-report; status=$$?; $(MAKE) audit-clean; exit $$status

# audit/scenario の一回限りコンテナが残っていれば削除する
# (docker compose run --rm 使用時は通常不要だが、Ctrl-C等で中断した場合の保険)
audit-clean:
	docker ps -aq --filter "name=gekko_05-scenario-run" --filter "name=gekko_05-audit-run" | xargs -r docker rm -f
