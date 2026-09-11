.PHONY: up down stop start build up-build logs ps clean \
        audit-scenario audit-report audit-demo audit-clean

# -------------------------
# スタック操作
# -------------------------

# 全サービスをバックグラウンドで起動
up:
	docker compose up -d

# コード変更後にイメージを再ビルドして起動
up-build:
	docker compose up -d --build

# 全コンテナを停止・削除（ボリュームは残す）
down:
	docker compose down

# コンテナを停止（削除しない。DB データは保持される）
stop:
	docker compose stop

# stop で止めたコンテナを再開
start:
	docker compose start

# イメージをビルドのみ（起動はしない）
build:
	docker compose build

# 全サービスのログをフォロー（Ctrl-C で抜ける）
logs:
	docker compose logs -f

# 各コンテナの状態・ポートを確認
ps:
	docker compose ps

# コンテナ＋ボリューム（DB データ含む）を完全削除
clean:
	docker compose down -v

# -------------------------
# 監査
# -------------------------

# トラフィック生成（3ユーザーのログイン+API呼び出しでToken Exchangeチェーンを実際に
# 発生させる。加えてToken Exchangeを経ないバイパスアクセスを1件生成し、
# audit-reportのCHECK2が実際に検知する様子をデモする）
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
