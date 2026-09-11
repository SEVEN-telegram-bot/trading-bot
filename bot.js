import time
import random
from solana.rpc.api import Client

# پێناسەکرنا گرێدانێ دگەل تۆڕا سۆلانا
RPC_URL = "https://api.mainnet-beta.solana.com"
client = Client(RPC_URL)

TOKEN_ADDRESS = "Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53"

def execute_micro_trade(action, amount):
    """جێبەجێکرنا کڕین یان فرۆتنا بچووک ل سەر چارتێ"""
    print(f"Executing {action} of {amount} SOL value on {TOKEN_ADDRESS[:6]}...")
    # لێرە ژڤانێ API یێ Jupiter یان Raydium دێ ئەنجام دەت

def run_market_maker(duration_hours=24):
    """بەردەوامکرنا چارتێ بۆ ماوێ تە دیارکری"""
    end_time = time.time() + (duration_hours * 3600)
    
    while time.time() < end_time:
        # بڕەکێ گەلەک کێم هەڵبژێرە دا چارت تێک نەچیت
        trade_size = round(random.uniform(0.01, 0.04), 3) 
        
        # ڕێکخستنا کڕین یان فرۆتن ب شێوەیێ هەڕەمەکی بۆ جوانکرنا چارتێ
        trade_type = random.choice(["BUY", "BUY", "SELL"]) # کڕین زێدەتر بیت دا کەسک ببیت
        
        execute_micro_trade(trade_type, trade_size)
        
        # وەستان د ناڤبەرا ٤٥ چرکە بۆ ٢ خۆلەکان
        sleep_interval = random.randint(45, 120)
        time.sleep(sleep_interval)

# run_market_maker(24) # دەستپێکرنا کۆدی بۆ ماوێ ٢٤ دەمژمێران
